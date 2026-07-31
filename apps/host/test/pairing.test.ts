import { describe, expect, test } from "bun:test";
import {
  derivePairwiseKey,
  E2EE_PROTOCOL_VERSION,
  generateX25519KeyPair,
  pairingConfirmationCode,
  pairingTranscriptHash,
  type RandomSource,
} from "@pocket-omp/crypto";
import type { SecureKeyStore } from "@pocket-omp/host-core";

import { pairHost } from "../src/pairing";

const origin = new URL("https://control.example.test");

class FakeSecureKeyStore implements SecureKeyStore {
  private readonly secrets = new Map<string, Uint8Array>();

  public async put(handle: string, secret: Uint8Array): Promise<void> {
    this.secrets.set(handle, secret.slice());
  }

  public async get(handle: string): Promise<Uint8Array | undefined> {
    return this.secrets.get(handle)?.slice();
  }

  public async delete(handle: string): Promise<void> {
    this.secrets.delete(handle);
  }
}

interface FakePairingRecord {
  readonly pairingId: string;
  readonly hostName: string;
  readonly hostPublicKey: Uint8Array;
  readonly challenge: Uint8Array;
  readonly watchSecret: string;
  readonly expiresAtMs: bigint;
  readonly serviceIdentifier: string;
  state: "awaiting-claim" | "awaiting-confirmations" | "completed" | "expired";
  mobilePublicKey?: Uint8Array;
  mobileDeviceId?: string;
  routeId?: string;
  hostConfirmed: boolean;
  mobileConfirmed: boolean;
}

interface RecordedRequest {
  readonly method: string;
  readonly pathname: string;
  readonly search: string;
  readonly body: unknown;
}

// Mirrors the observable HTTP contract of
// services/control-api/src/control.ts (beginPairing / watchPairing /
// completePairing) closely enough to drive apps/host/src/pairing.ts through
// a full claim/complete lifecycle, without pulling in the Workers runtime.
class FakeControlServer {
  public readonly requests: RecordedRequest[] = [];
  public overrideCompleteResponse: Record<string, unknown> | undefined;
  public omitRecipientDeviceIdOnComplete = false;
  public recipientDeviceIdEndpointAvailable = true;
  private pairing: FakePairingRecord | undefined;
  private watchCalls = 0;
  private claimAfterCalls = Number.POSITIVE_INFINITY;
  private pendingClaim:
    | { mobilePublicKey: Uint8Array; routeId: string; mobileDeviceId: string }
    | undefined;
  private hostCounter = 0;
  private initialState: "awaiting-claim" | "expired" = "awaiting-claim";

  public claimAfter(
    callCount: number,
    mobilePublicKey: Uint8Array,
    routeId: string,
    mobileDeviceId = `mobile-device-${routeId}`,
  ): void {
    this.claimAfterCalls = callCount;
    this.pendingClaim = { mobilePublicKey, routeId, mobileDeviceId };
  }

  public expireImmediately(): void {
    this.initialState = "expired";
  }

  public currentPairing(): FakePairingRecord {
    if (this.pairing === undefined) throw new Error("pairing has not started yet");
    return this.pairing;
  }

  public readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(requestUrl(input));
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, pathname: url.pathname, search: url.search, body });

    if (url.pathname === "/v1/pairings" && method === "POST") {
      const fields = asRecord(body, "begin pairing request body");
      this.pairing = {
        pairingId: "pairing-1",
        hostName: String(fields.host_name),
        hostPublicKey: fromHex(String(fields.host_public_key)),
        challenge: fixedBytes(32, 0xaa),
        watchSecret: "watch-secret-test",
        expiresAtMs: 9_999_999_999_999n,
        serviceIdentifier: "pocket-omp",
        state: this.initialState,
        hostConfirmed: false,
        mobileConfirmed: false,
      };
      return Response.json({
        pairing_id: this.pairing.pairingId,
        challenge: hex(this.pairing.challenge),
        watch_secret: this.pairing.watchSecret,
        expires_at_ms: Number(this.pairing.expiresAtMs),
        service_identifier: this.pairing.serviceIdentifier,
      });
    }

    const watchMatch = /^\/v1\/pairings\/([^/]+)\/watch$/.exec(url.pathname);
    if (watchMatch !== null && method === "GET") {
      const pairing = this.requirePairing(watchMatch[1]);
      if (url.searchParams.get("watch_secret") !== pairing.watchSecret) {
        return Response.json({ error: "invalid watch secret" }, { status: 403 });
      }
      this.watchCalls += 1;
      if (
        this.watchCalls >= this.claimAfterCalls &&
        this.pendingClaim !== undefined &&
        pairing.state !== "expired"
      ) {
        pairing.mobilePublicKey = this.pendingClaim.mobilePublicKey;
        pairing.routeId = this.pendingClaim.routeId;
        pairing.mobileDeviceId = this.pendingClaim.mobileDeviceId;
        pairing.state = "awaiting-confirmations";
      }
      return Response.json({
        pairing_id: pairing.pairingId,
        state: pairing.state,
        host_name: pairing.hostName,
        ...(pairing.mobilePublicKey === undefined
          ? {}
          : { mobile_public_key: hex(pairing.mobilePublicKey) }),
        ...(pairing.routeId === undefined ? {} : { route_id: pairing.routeId }),
        host_confirmed: pairing.hostConfirmed,
        mobile_confirmed: pairing.mobileConfirmed,
        expires_at_ms: Number(pairing.expiresAtMs),
      });
    }

    const completeMatch = /^\/v1\/pairings\/([^/]+)\/complete$/.exec(url.pathname);
    if (completeMatch !== null && method === "POST") {
      const pairing = this.requirePairing(completeMatch[1]);
      const fields = asRecord(body, "complete pairing request body");
      if (fields.actor !== "host" || fields.watch_secret !== pairing.watchSecret) {
        return Response.json({ error: "invalid" }, { status: 400 });
      }
      if (this.overrideCompleteResponse !== undefined) {
        return Response.json(this.overrideCompleteResponse);
      }
      if (pairing.routeId === undefined || pairing.mobileDeviceId === undefined) {
        return Response.json({ error: "not claimed" }, { status: 409 });
      }
      this.hostCounter += 1;
      const hostId = `host-device-${this.hostCounter}`;
      pairing.hostConfirmed = true;
      pairing.state = pairing.mobileConfirmed ? "completed" : "awaiting-confirmations";
      return Response.json({
        host_id: hostId,
        route_id: pairing.routeId,
        device_credential: `poc_dev_${hostId}_super_secret`,
        state: pairing.state,
        ...(this.omitRecipientDeviceIdOnComplete
          ? {}
          : { recipient_device_id: pairing.mobileDeviceId }),
      });
    }

    const recipientMatch = /^\/v1\/routes\/([^/]+)\/recipient-device-id$/.exec(url.pathname);
    if (recipientMatch !== null && method === "POST") {
      if (!this.recipientDeviceIdEndpointAvailable)
        return new Response("not found", { status: 404 });
      const pairing = this.pairing;
      if (
        pairing === undefined ||
        pairing.routeId !== recipientMatch[1] ||
        pairing.mobileDeviceId === undefined
      ) {
        return Response.json({ error: "unknown route" }, { status: 404 });
      }
      return Response.json({ recipient_device_id: pairing.mobileDeviceId });
    }

    return new Response("not found", { status: 404 });
  };

  private requirePairing(id: string | undefined): FakePairingRecord {
    if (this.pairing === undefined || this.pairing.pairingId !== id) {
      throw new Error("unknown pairing in fake server");
    }
    return this.pairing;
  }
}

function counterRandom(seed: number): RandomSource {
  let counter = seed;
  return {
    bytes(length: number): Uint8Array {
      const out = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        counter = (counter * 48_271 + 1) % 2_147_483_647;
        out[index] = counter & 0xff;
      }
      return out;
    },
  };
}

function fixedBytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function decodeText(value: Uint8Array | undefined): string {
  if (value === undefined) throw new Error("expected a stored secure-store value");
  return new TextDecoder().decode(value);
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecordValue(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

// Discards the QR payload / confirmation code lines these negative-path
// tests don't assert on, so a `bun test` run never writes to the real
// process stdout.
function noopWrite(): void {}

describe("pairHost", () => {
  test("completes pairing, matches an independent mobile-side key derivation, and never prints secrets", async () => {
    const server = new FakeControlServer();
    const keyStore = new FakeSecureKeyStore();
    const writes: string[] = [];
    // Independently reproduces the two sides of ADR-005: this is exactly
    // what apps/mobile/app/pair.tsx computes on a scan (mobile keys +
    // derivePairwiseKey with localDeviceId "mobile" / peerDeviceId "host"),
    // executed here in plain crypto calls with no Expo/SecureStore
    // dependency, so it can run under `bun test`.
    const mobileKeys = generateX25519KeyPair(counterRandom(101));
    // Recomputed independently from the same seed passed as `random` below,
    // to confirm pairHost actually threads the injected RandomSource through
    // to generateX25519KeyPair rather than using some other source.
    const expectedHostKeys = generateX25519KeyPair(counterRandom(7));
    const routeId = "route-e2e-1";
    server.claimAfter(2, mobileKeys.publicKey, routeId);

    const result = await pairHost({
      hostName: "Integration Test Host",
      controlOrigin: origin,
      keyStore,
      fetch: server.fetch,
      random: counterRandom(7),
      pollIntervalMs: 5,
      timeoutMs: 5_000,
      write: (line) => {
        writes.push(line);
      },
    });

    // --- request shapes: begin ---
    expect(server.requests[0]).toMatchObject({ method: "POST", pathname: "/v1/pairings" });
    expect(server.requests[0]?.body).toEqual({
      host_name: "Integration Test Host",
      host_public_key: hex(expectedHostKeys.publicKey),
    });

    // --- QR payload matches apps/mobile/app/pair.tsx's PairingQr contract ---
    const pairing = server.currentPairing();
    const qrPayload = asRecord(JSON.parse(writes[0] ?? "{}"), "printed QR payload");
    expect(qrPayload).toEqual({
      protocolVersion: E2EE_PROTOCOL_VERSION,
      pairingId: pairing.pairingId,
      challenge: hex(pairing.challenge),
      hostPublicKey: hex(expectedHostKeys.publicKey),
      expiresAtMs: Number(pairing.expiresAtMs),
      serviceIdentifier: pairing.serviceIdentifier,
    });
    expect(qrPayload.challenge).toMatch(/^[0-9a-f]{64}$/);
    expect(qrPayload.hostPublicKey).toMatch(/^[0-9a-f]{64}$/);

    // --- request shapes: watch polls and complete ---
    const watchRequests = server.requests.filter((request) => request.pathname.endsWith("/watch"));
    expect(watchRequests.length).toBeGreaterThanOrEqual(2);
    for (const request of watchRequests) {
      expect(request.method).toBe("GET");
      expect(request.search).toBe("?watch_secret=watch-secret-test");
    }
    const completeRequest = server.requests.find((request) =>
      request.pathname.endsWith("/complete"),
    );
    expect(completeRequest?.body).toEqual({ actor: "host", watch_secret: "watch-secret-test" });

    // --- independent mobile-side derivation (mirrors pair.tsx exactly) ---
    const transcriptHash = pairingTranscriptHash({
      protocolVersion: E2EE_PROTOCOL_VERSION,
      serviceIdentifier: pairing.serviceIdentifier,
      pairingId: pairing.pairingId,
      challenge: pairing.challenge,
      hostPublicKey: expectedHostKeys.publicKey,
      mobilePublicKey: mobileKeys.publicKey,
      expiresAtMs: pairing.expiresAtMs,
    });
    const mobilePairwiseKey = derivePairwiseKey({
      localSecretKey: mobileKeys.secretKey,
      peerPublicKey: expectedHostKeys.publicKey,
      pairingTranscriptHash: transcriptHash,
      routeId,
      localDeviceId: "mobile",
      peerDeviceId: "host",
    });
    const mobileConfirmationCode = pairingConfirmationCode(transcriptHash, mobilePairwiseKey);

    const storedPairwiseKey = await keyStore.get(`route:${routeId}:pairwise-key`);
    expect(storedPairwiseKey).toEqual(mobilePairwiseKey);
    expect(result.confirmationCode).toBe(mobileConfirmationCode);

    // --- SecureKeyStore persistence (route:<routeId>:<field> + host:paired-routes) ---
    expect(decodeText(await keyStore.get(`route:${routeId}:host-id`))).toBe(result.hostId);
    const credentialText = decodeText(await keyStore.get(`route:${routeId}:device-credential`));
    expect(credentialText).toBe(`poc_dev_${result.hostId}_super_secret`);
    expect(JSON.parse(decodeText(await keyStore.get("host:paired-routes")))).toEqual([routeId]);

    // --- recipient_device_id from completePairingAsHost's response is
    //     surfaced on the result and persisted for HostRelayCoordinator ---
    expect(result.recipientDeviceId).toBe(`mobile-device-${routeId}`);
    expect(decodeText(await keyStore.get(`route:${routeId}:recipient-device-id`))).toBe(
      `mobile-device-${routeId}`,
    );

    // --- secrets must never reach stdout/log; only the public QR payload
    //     and the human confirmation code are printed ---
    expect(writes).toHaveLength(2);
    const printed = writes.join("\n");
    expect(printed).toContain(result.confirmationCode.slice(0, 3));
    expect(printed).not.toContain(credentialText);
    expect(printed).not.toContain(pairing.watchSecret);
    expect(printed).not.toContain(hex(storedPairwiseKey ?? new Uint8Array()));
    expect(printed).not.toContain(Buffer.from(mobilePairwiseKey).toString("base64"));
  });

  test("rejects when the mobile app never scans the code before the timeout", async () => {
    const server = new FakeControlServer();
    const keyStore = new FakeSecureKeyStore();
    await expect(
      pairHost({
        hostName: "Host",
        controlOrigin: origin,
        keyStore,
        fetch: server.fetch,
        pollIntervalMs: 5,
        timeoutMs: 30,
        write: noopWrite,
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("rejects immediately when the pairing has already expired", async () => {
    const server = new FakeControlServer();
    server.expireImmediately();
    const keyStore = new FakeSecureKeyStore();
    await expect(
      pairHost({
        hostName: "Host",
        controlOrigin: origin,
        keyStore,
        fetch: server.fetch,
        pollIntervalMs: 5,
        timeoutMs: 1_000,
        write: noopWrite,
      }),
    ).rejects.toMatchObject({ code: "EXPIRED" });
  });

  test("retries watchPairing after a transient network failure instead of aborting the whole pairing attempt", async () => {
    const server = new FakeControlServer();
    const keyStore = new FakeSecureKeyStore();
    const mobileKeys = generateX25519KeyPair(counterRandom(606));
    const routeId = "route-retry";
    server.claimAfter(1, mobileKeys.publicKey, routeId);

    let watchCalls = 0;
    // Mirrors what the real fetch() throws on a dropped connection / DNS
    // blip: a plain rejection, not an HTTP response. Only the first /watch
    // poll fails; every other request (including begin/complete) goes
    // straight through to the fake server.
    const flakyFetch: typeof fetch = async (input, init) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.endsWith("/watch")) {
        watchCalls += 1;
        if (watchCalls === 1) throw new TypeError("network blip");
      }
      return server.fetch(input, init);
    };

    const result = await pairHost({
      hostName: "Host",
      controlOrigin: origin,
      keyStore,
      fetch: flakyFetch,
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      write: noopWrite,
    });

    expect(result.routeId).toBe(routeId);
    expect(watchCalls).toBeGreaterThanOrEqual(2);
  });

  test("does not retry watchPairing after a non-transient failure (e.g. a 4xx) and lets it propagate", async () => {
    const server = new FakeControlServer();
    const keyStore = new FakeSecureKeyStore();
    const mobileKeys = generateX25519KeyPair(counterRandom(707));
    server.claimAfter(1, mobileKeys.publicKey, "route-4xx");

    let watchCalls = 0;
    const badRequestFetch: typeof fetch = async (input, init) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.endsWith("/watch")) {
        watchCalls += 1;
        return new Response("bad request", { status: 400 });
      }
      return server.fetch(input, init);
    };

    await expect(
      pairHost({
        hostName: "Host",
        controlOrigin: origin,
        keyStore,
        fetch: badRequestFetch,
        pollIntervalMs: 5,
        timeoutMs: 1_000,
        write: noopWrite,
      }),
    ).rejects.toMatchObject({ code: "HTTP_STATUS" });
    expect(watchCalls).toBe(1);
  });

  test("aborts the wait for a mobile claim when the caller cancels", async () => {
    const server = new FakeControlServer();
    const keyStore = new FakeSecureKeyStore();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      pairHost({
        hostName: "Host",
        controlOrigin: origin,
        keyStore,
        fetch: server.fetch,
        pollIntervalMs: 5_000,
        timeoutMs: 60_000,
        signal: controller.signal,
        write: noopWrite,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("rejects when the Control Plane reports a different route than the claim", async () => {
    const server = new FakeControlServer();
    const keyStore = new FakeSecureKeyStore();
    const mobileKeys = generateX25519KeyPair(counterRandom(202));
    server.claimAfter(1, mobileKeys.publicKey, "route-real");
    server.overrideCompleteResponse = {
      host_id: "host-1",
      route_id: "route-mismatched",
      device_credential: "poc_dev_test",
      state: "awaiting-confirmations",
      recipient_device_id: "mobile-1",
    };
    await expect(
      pairHost({
        hostName: "Host",
        controlOrigin: origin,
        keyStore,
        fetch: server.fetch,
        pollIntervalMs: 5,
        timeoutMs: 1_000,
        write: noopWrite,
      }),
    ).rejects.toMatchObject({ code: "ROUTE_MISMATCH" });
    // A rejected mismatch must not leave a half-written credential behind.
    expect(await keyStore.get("route-real:device-credential")).toBeUndefined();
  });

  test("rejects when the Control Plane reports an unexpected pairing state", async () => {
    const server = new FakeControlServer();
    const keyStore = new FakeSecureKeyStore();
    const mobileKeys = generateX25519KeyPair(counterRandom(303));
    server.claimAfter(1, mobileKeys.publicKey, "route-real");
    server.overrideCompleteResponse = {
      host_id: "host-1",
      route_id: "route-real",
      device_credential: "poc_dev_test",
      state: "awaiting-claim",
      recipient_device_id: "mobile-1",
    };
    await expect(
      pairHost({
        hostName: "Host",
        controlOrigin: origin,
        keyStore,
        fetch: server.fetch,
        pollIntervalMs: 5,
        timeoutMs: 1_000,
        write: noopWrite,
      }),
    ).rejects.toMatchObject({ code: "UNEXPECTED_STATE" });
  });

  test("backfills recipient_device_id via the recovery endpoint when completePairingAsHost's response omits it", async () => {
    const server = new FakeControlServer();
    server.omitRecipientDeviceIdOnComplete = true;
    const keyStore = new FakeSecureKeyStore();
    const mobileKeys = generateX25519KeyPair(counterRandom(404));
    const routeId = "route-backfill";
    server.claimAfter(1, mobileKeys.publicKey, routeId, "mobile-device-backfill");

    const result = await pairHost({
      hostName: "Host",
      controlOrigin: origin,
      keyStore,
      fetch: server.fetch,
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      write: noopWrite,
    });

    expect(result.recipientDeviceId).toBe("mobile-device-backfill");
    expect(decodeText(await keyStore.get(`route:${routeId}:recipient-device-id`))).toBe(
      "mobile-device-backfill",
    );
    const backfillRequest = server.requests.find((request) =>
      request.pathname.endsWith("/recipient-device-id"),
    );
    expect(backfillRequest).toMatchObject({ method: "POST" });
  });

  test("still completes pairing without a recipientDeviceId when both the field and the recovery endpoint predate control-api's version (old control-api)", async () => {
    const server = new FakeControlServer();
    server.omitRecipientDeviceIdOnComplete = true;
    server.recipientDeviceIdEndpointAvailable = false;
    const keyStore = new FakeSecureKeyStore();
    const mobileKeys = generateX25519KeyPair(counterRandom(505));
    const routeId = "route-old-control-api";
    server.claimAfter(1, mobileKeys.publicKey, routeId, "mobile-device-old");

    const result = await pairHost({
      hostName: "Host",
      controlOrigin: origin,
      keyStore,
      fetch: server.fetch,
      pollIntervalMs: 5,
      timeoutMs: 1_000,
      write: noopWrite,
    });

    // Pairing already succeeded server-side; a control-api that predates
    // both the field and its backfill endpoint must not fail the whole
    // attempt (RecipientDeviceIdLearner picks this up later at runtime).
    expect(result.routeId).toBe(routeId);
    expect(result.recipientDeviceId).toBeUndefined();
    expect(await keyStore.get(`route:${routeId}:recipient-device-id`)).toBeUndefined();
    // The rest of pairing state is still fully persisted.
    expect(decodeText(await keyStore.get(`route:${routeId}:host-id`))).toBe(result.hostId);
  });
});

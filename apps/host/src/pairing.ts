// Host-side pairing flow (ADR-005 pairwise E2EE, ADR-013 official relay).
//
// This must stay byte-for-byte symmetric with the mobile pairing flow in
// apps/mobile/app/pair.tsx: both sides build the same
// `pairingTranscriptHash` input and feed it into `derivePairwiseKey` with
// swapped local/peer arguments so the two independently-derived pairwise
// keys match. See that file before changing anything here.
import {
  derivePairwiseKey,
  E2EE_PROTOCOL_VERSION,
  generateX25519KeyPair,
  pairingConfirmationCode,
  pairingTranscriptHash,
  type RandomSource,
} from "@pocket-omp/crypto";
import type { SecureKeyStore } from "@pocket-omp/host-core";

import {
  ControlClient,
  ControlClientError,
  type ControlClientOptions,
  type WatchPairingResult,
} from "./control-client";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const STATE_EXPIRED = "expired";
const STATE_AWAITING_CONFIRMATIONS = "awaiting-confirmations";
const STATE_COMPLETED = "completed";
const PAIRED_ROUTES_HANDLE = "host:paired-routes";

export interface PairHostOptions {
  readonly hostName: string;
  readonly controlOrigin: URL;
  readonly keyStore: SecureKeyStore;
  readonly fetch?: typeof fetch;
  readonly random?: RandomSource;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly write?: (line: string) => Promise<void> | void;
}

export interface PairHostResult {
  readonly routeId: string;
  readonly hostId: string;
  readonly confirmationCode: string;
  /**
   * The paired Mobile device's device_id, already persisted to the
   * SecureKeyStore (see ./recipient-device-id-learner.ts for how
   * HostRelayCoordinator consumes it). Undefined when it could not be
   * learned at pairing time (control-api predates the field and its
   * backfill endpoint) -- RecipientDeviceIdLearner still learns it later
   * from the first authenticated inbound envelope on this route.
   */
  readonly recipientDeviceId?: string;
}

export async function pairHost(options: PairHostOptions): Promise<PairHostResult> {
  const clientOptions: ControlClientOptions = {
    origin: options.controlOrigin,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const client = new ControlClient(clientOptions);
  const random: RandomSource = options.random ?? {
    bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  };
  const write = options.write ?? defaultWrite;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const hostKeys = generateX25519KeyPair(random);
  const begin = await client.beginPairing(
    { hostName: options.hostName, hostPublicKey: hostKeys.publicKey },
    options.signal,
  );

  // Mirrors the `PairingQr` shape parsed by `parsePairingQr` in pair.tsx:
  // protocolVersion / pairingId / challenge / hostPublicKey / expiresAtMs /
  // serviceIdentifier, all as their exact camelCase field names.
  const qrPayload = {
    protocolVersion: E2EE_PROTOCOL_VERSION,
    pairingId: begin.pairingId,
    challenge: hex(begin.challenge),
    hostPublicKey: hex(hostKeys.publicKey),
    expiresAtMs: Number(begin.expiresAtMs),
    serviceIdentifier: begin.serviceIdentifier,
  };
  await write(`${JSON.stringify(qrPayload)}\n`);

  const claim = await waitForClaim(client, begin.pairingId, begin.watchSecret, {
    pollIntervalMs,
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  // Symmetric with pair.tsx's transcriptHash computation: same field values,
  // same byte layout, so both sides hash an identical transcript.
  const transcriptHash = pairingTranscriptHash({
    protocolVersion: E2EE_PROTOCOL_VERSION,
    serviceIdentifier: begin.serviceIdentifier,
    pairingId: begin.pairingId,
    challenge: begin.challenge,
    hostPublicKey: hostKeys.publicKey,
    mobilePublicKey: claim.mobilePublicKey,
    expiresAtMs: begin.expiresAtMs,
  });
  // Symmetric with pair.tsx's derivePairwiseKey call: mobile passes
  // (localSecretKey: mobile, peerPublicKey: host, localDeviceId: "mobile",
  // peerDeviceId: "host"). The Host side swaps both pairs; X25519 ECDH is
  // symmetric and the HKDF info sorts device IDs, so the two independently
  // derived keys are identical.
  const pairwiseKey = derivePairwiseKey({
    localSecretKey: hostKeys.secretKey,
    peerPublicKey: claim.mobilePublicKey,
    pairingTranscriptHash: transcriptHash,
    routeId: claim.routeId,
    localDeviceId: "host",
    peerDeviceId: "mobile",
  });
  const confirmationCode = pairingConfirmationCode(transcriptHash, pairwiseKey);
  await write(`Confirmation code: ${confirmationCode.slice(0, 3)} ${confirmationCode.slice(3)}\n`);

  const completed = await client.completePairingAsHost(
    begin.pairingId,
    begin.watchSecret,
    options.signal,
  );
  if (completed.routeId !== claim.routeId) {
    throw new PairingError(
      "ROUTE_MISMATCH",
      "Pairing completion returned a different route than the claim",
    );
  }
  if (completed.state !== STATE_AWAITING_CONFIRMATIONS && completed.state !== STATE_COMPLETED) {
    throw new PairingError("UNEXPECTED_STATE", `Unexpected pairing state: ${completed.state}`);
  }

  const recipientDeviceId =
    completed.recipientDeviceId ??
    (await backfillRecipientDeviceId(client, {
      routeId: completed.routeId,
      hostId: completed.hostId,
      deviceCredential: completed.deviceCredential,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }));

  await persistPairing(options.keyStore, {
    routeId: completed.routeId,
    hostId: completed.hostId,
    deviceCredential: completed.deviceCredential,
    pairwiseKey,
    ...(recipientDeviceId === undefined ? {} : { recipientDeviceId }),
  });

  return {
    routeId: completed.routeId,
    hostId: completed.hostId,
    confirmationCode,
    ...(recipientDeviceId === undefined ? {} : { recipientDeviceId }),
  };
}

interface BackfillRecipientDeviceIdInput {
  readonly routeId: string;
  readonly hostId: string;
  readonly deviceCredential: string;
  readonly signal?: AbortSignal;
}

// completePairingAsHost's response omits recipient_device_id when talking to
// a control-api deployment that predates that field. Pairing has already
// succeeded server-side by that point, so this is a best-effort backfill via
// the dedicated recovery endpoint (see ControlClient.getRouteRecipientDevice)
// -- not something that should fail the whole pairing attempt if it too is
// unavailable (e.g. an even older control-api that predates this endpoint as
// well). RecipientDeviceIdLearner still learns the recipient later, from the
// first authenticated inbound envelope on this route.
async function backfillRecipientDeviceId(
  client: ControlClient,
  input: BackfillRecipientDeviceIdInput,
): Promise<string | undefined> {
  try {
    return await client.getRouteRecipientDevice(
      {
        routeId: input.routeId,
        deviceId: input.hostId,
        deviceCredential: input.deviceCredential,
      },
      input.signal,
    );
  } catch {
    return undefined;
  }
}

interface ClaimedPairing {
  readonly mobilePublicKey: Uint8Array;
  readonly routeId: string;
}

interface WaitForClaimOptions {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

async function waitForClaim(
  client: ControlClient,
  pairingId: string,
  watchSecret: string,
  options: WaitForClaimOptions,
): Promise<ClaimedPairing> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    if (options.signal?.aborted === true) {
      throw new PairingError("ABORTED", "Pairing was aborted");
    }
    let watch: WatchPairingResult | undefined;
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each poll must observe the previous response first.
      watch = await client.watchPairing(pairingId, watchSecret, options.signal);
    } catch (error) {
      if (!isTransientControlError(error)) throw error;
      watch = undefined;
    }
    if (watch !== undefined) {
      if (watch.state === STATE_EXPIRED) {
        throw new PairingError("EXPIRED", "Pairing expired before the mobile app scanned it");
      }
      if (watch.mobilePublicKey !== undefined && watch.routeId !== undefined) {
        return { mobilePublicKey: watch.mobilePublicKey, routeId: watch.routeId };
      }
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new PairingError(
        "TIMEOUT",
        "Timed out waiting for the mobile app to scan the pairing code",
      );
    }
    // oxlint-disable-next-line no-await-in-loop -- Polling requires a bounded wait between requests.
    await delay(Math.min(options.pollIntervalMs, remainingMs), options.signal);
  }
}

// A single dropped connection, DNS blip, or 5xx during the (up to
// timeoutMs-long) pairing wait must not abort the whole attempt -- the next
// poll tick just tries again. A malformed response or a 4xx (e.g. an invalid
// watch_secret, which will never self-correct) is not retried.
function isTransientControlError(error: unknown): boolean {
  if (!(error instanceof ControlClientError)) return false;
  if (error.code === "NETWORK") return true;
  return error.code === "HTTP_STATUS" && error.status !== undefined && error.status >= 500;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new PairingError("ABORTED", "Pairing was aborted"));
    };
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface PersistPairingInput {
  readonly routeId: string;
  readonly hostId: string;
  readonly deviceCredential: string;
  readonly pairwiseKey: Uint8Array;
  readonly recipientDeviceId?: string;
}

// Secure-store key naming convention:
//   route:<routeId>:host-id              -> UTF-8 encoded Host device id
//   route:<routeId>:device-credential    -> UTF-8 encoded bearer credential
//   route:<routeId>:pairwise-key         -> raw 32-byte pairwise AEAD key
//   route:<routeId>:recipient-device-id  -> UTF-8 encoded paired Mobile device id
//   host:paired-routes                   -> JSON array of known route ids
async function persistPairing(keyStore: SecureKeyStore, input: PersistPairingInput): Promise<void> {
  const encoder = new TextEncoder();
  await keyStore.put(routeHandle(input.routeId, "host-id"), encoder.encode(input.hostId));
  await keyStore.put(
    routeHandle(input.routeId, "device-credential"),
    encoder.encode(input.deviceCredential),
  );
  await keyStore.put(routeHandle(input.routeId, "pairwise-key"), input.pairwiseKey);
  if (input.recipientDeviceId !== undefined) {
    await keyStore.put(
      routeHandle(input.routeId, "recipient-device-id"),
      encoder.encode(input.recipientDeviceId),
    );
  }
  const routes = await readPairedRoutes(keyStore);
  if (!routes.includes(input.routeId)) {
    routes.push(input.routeId);
    await keyStore.put(PAIRED_ROUTES_HANDLE, encoder.encode(JSON.stringify(routes)));
  }
}

async function readPairedRoutes(keyStore: SecureKeyStore): Promise<string[]> {
  const stored = await keyStore.get(PAIRED_ROUTES_HANDLE);
  if (stored === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(stored));
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function routeHandle(routeId: string, field: string): string {
  return `route:${routeId}:${field}`;
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function defaultWrite(line: string): Promise<void> {
  await Bun.write(Bun.stdout, line);
}

export class PairingError extends Error {
  public constructor(
    public readonly code: "TIMEOUT" | "ABORTED" | "EXPIRED" | "ROUTE_MISMATCH" | "UNEXPECTED_STATE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PairingError";
  }
}

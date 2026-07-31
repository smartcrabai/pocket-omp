import { AEAD_KEY_BYTES } from "@pocket-omp/crypto";
import { HostRelayCoordinator, type SecureKeyStore } from "@pocket-omp/host-core";
import { expect, test } from "bun:test";
import { buildHostRelayCoordinator } from "../src/relay-composition";

class MemoryKeyStore implements SecureKeyStore {
  private readonly values = new Map<string, Uint8Array>();
  public async put(handle: string, secret: Uint8Array): Promise<void> {
    this.values.set(handle, secret.slice());
  }
  public async get(handle: string): Promise<Uint8Array | undefined> {
    return this.values.get(handle)?.slice();
  }
  public async delete(handle: string): Promise<void> {
    this.values.delete(handle);
  }
}

const routeId = "route-1";
const controlOrigin = new URL("https://control.example.test");

async function pairedKeyStore(): Promise<MemoryKeyStore> {
  const keyStore = new MemoryKeyStore();
  await keyStore.put(`route:${routeId}:host-id`, new TextEncoder().encode("host-1"));
  await keyStore.put(
    `route:${routeId}:device-credential`,
    new TextEncoder().encode("poc_dev_secret"),
  );
  await keyStore.put(`route:${routeId}:pairwise-key`, new Uint8Array(AEAD_KEY_BYTES).fill(0x55));
  return keyStore;
}

interface RecordedTicketRequest {
  readonly pathname: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function fakeControlFetch(requests: RecordedTicketRequest[]): typeof fetch {
  return async (input, init) => {
    const url = new URL(requestUrl(input));
    const headers = new Headers(init?.headers);
    requests.push({
      pathname: url.pathname,
      authorization: headers.get("authorization"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url.pathname === "/v1/relay-tickets") {
      return Response.json({
        ticket: "eyJhbGciOiJFZERTQSJ9.fake.signature",
        relay_origin: "https://relay.example.test",
        expires_at_ms: 1_700_000_600_000,
        route_epoch: "1",
      });
    }
    return new Response("not found", { status: 404 });
  };
}

async function failingFetch(): Promise<Response> {
  return new Response("nope", { status: 500 });
}

test("builds a HostRelayCoordinator using this route's stored pairing identity, requesting exactly the routes it owns", async () => {
  const keyStore = await pairedKeyStore();
  const requests: RecordedTicketRequest[] = [];
  const composition = await buildHostRelayCoordinator({
    routeId,
    controlOrigin,
    keyStore,
    fetch: fakeControlFetch(requests),
  });
  expect(composition.coordinator).toBeInstanceOf(HostRelayCoordinator);
  expect(requests).toEqual([
    {
      pathname: "/v1/relay-tickets",
      authorization: "Bearer poc_dev_secret",
      body: { device_id: "host-1", route_ids: [routeId] },
    },
  ]);
  expect(composition.hostId).toBe("host-1");
  expect(composition.recipientDeviceId()).toBeUndefined();
  composition.close();
});

test("seeds recipientDeviceId from initialRecipientDeviceId when provided", async () => {
  const keyStore = await pairedKeyStore();
  const composition = await buildHostRelayCoordinator({
    routeId,
    controlOrigin,
    keyStore,
    fetch: fakeControlFetch([]),
    initialRecipientDeviceId: "mobile-configured",
  });
  expect(composition.recipientDeviceId()).toBe("mobile-configured");
  composition.close();
});

test("seeds recipientDeviceId from the peer device id persisted at pairing time", async () => {
  const keyStore = await pairedKeyStore();
  await keyStore.put(
    `route:${routeId}:recipient-device-id`,
    new TextEncoder().encode("mobile-paired"),
  );
  const composition = await buildHostRelayCoordinator({
    routeId,
    controlOrigin,
    keyStore,
    fetch: fakeControlFetch([]),
  });
  // Without this, Host could not address outbound events until Mobile happened
  // to send something first (see ./recipient-device-id-learner.test.ts).
  expect(composition.recipientDeviceId()).toBe("mobile-paired");
  composition.close();
});

test("initialRecipientDeviceId overrides the persisted peer device id", async () => {
  const keyStore = await pairedKeyStore();
  await keyStore.put(
    `route:${routeId}:recipient-device-id`,
    new TextEncoder().encode("mobile-paired"),
  );
  const composition = await buildHostRelayCoordinator({
    routeId,
    controlOrigin,
    keyStore,
    fetch: fakeControlFetch([]),
    initialRecipientDeviceId: "mobile-configured",
  });
  expect(composition.recipientDeviceId()).toBe("mobile-configured");
  composition.close();
});

test("ignores an empty persisted peer device id and falls back to learning", async () => {
  const keyStore = await pairedKeyStore();
  await keyStore.put(`route:${routeId}:recipient-device-id`, new Uint8Array());
  const composition = await buildHostRelayCoordinator({
    routeId,
    controlOrigin,
    keyStore,
    fetch: fakeControlFetch([]),
  });
  expect(composition.recipientDeviceId()).toBeUndefined();
  composition.close();
});

test("rejects when the route has no stored host device id or device credential", async () => {
  const keyStore = new MemoryKeyStore();
  await expect(
    buildHostRelayCoordinator({ routeId, controlOrigin, keyStore, fetch: fakeControlFetch([]) }),
  ).rejects.toMatchObject({ code: "NOT_PAIRED" });
});

test("rejects when only one half of the pairing identity is stored", async () => {
  const keyStore = new MemoryKeyStore();
  await keyStore.put(`route:${routeId}:host-id`, new TextEncoder().encode("host-1"));
  await expect(
    buildHostRelayCoordinator({ routeId, controlOrigin, keyStore, fetch: fakeControlFetch([]) }),
  ).rejects.toMatchObject({ code: "NOT_PAIRED" });
});

test("rejects an empty routeId", async () => {
  const keyStore = await pairedKeyStore();
  await expect(
    buildHostRelayCoordinator({
      routeId: "",
      controlOrigin,
      keyStore,
      fetch: fakeControlFetch([]),
    }),
  ).rejects.toMatchObject({ code: "INVALID_ROUTE" });
});

test("never leaks the device credential into a thrown error message when ticket issuance fails", async () => {
  const keyStore = await pairedKeyStore();
  try {
    await buildHostRelayCoordinator({
      routeId,
      controlOrigin,
      keyStore,
      fetch: failingFetch,
    });
    throw new Error("expected buildHostRelayCoordinator to reject");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain("poc_dev_secret");
  }
});

import { AEAD_KEY_BYTES, CryptoContractError, type RandomSource } from "@pocket-omp/crypto";
import type { HostInboundEnvelope, SecureKeyStore } from "@pocket-omp/host-core";
import { expect, test } from "bun:test";
import { HostEnvelopeCryptoError, RouteEnvelopeCrypto } from "../src/envelope-crypto";
import { outboundEnvelopeFromUnknown } from "../src/relay-envelope-codec";

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

class FixedRandom implements RandomSource {
  public constructor(private readonly fill: number) {}
  public bytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(this.fill);
  }
}

const routeId = "route-1";
const hostDeviceId = "host-device-1";
const mobileDeviceId = "mobile-1";
const pairwiseKey = new Uint8Array(AEAD_KEY_BYTES).fill(0x11);

async function keyStoreFor(hostId: string, key: Uint8Array): Promise<MemoryKeyStore> {
  const keyStore = new MemoryKeyStore();
  await keyStore.put(`route:${routeId}:host-id`, new TextEncoder().encode(hostId));
  await keyStore.put(`route:${routeId}:pairwise-key`, key);
  return keyStore;
}

function pairedKeyStore(): Promise<MemoryKeyStore> {
  return keyStoreFor(hostDeviceId, pairwiseKey);
}

function inbound(encrypted: unknown, serverSequence = 1n): HostInboundEnvelope {
  return { messageId: "message-1", serverSequence, encrypted };
}

function sequenceOf(item: { encrypted: unknown }): bigint {
  return outboundEnvelopeFromUnknown(item.encrypted, (message) => new Error(message))
    .clientSequence;
}

test("seal then open round-trips plaintext across the Host and Mobile sides of a route", async () => {
  // packages/crypto forbids sealing a message where sender == recipient
  // (canonicalEnvelopeAad's INVALID_ROUTE check), so a meaningful round trip
  // needs two distinct route participants: this Host, and a stand-in for
  // Mobile built from the same class (ADR-005's pairwise scheme is
  // symmetric, so RouteEnvelopeCrypto works equally well for either side).
  const hostCrypto = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await pairedKeyStore(),
    random: new FixedRandom(7),
    now: () => 1_800_000_000_000n,
    newMessageId: () => "message-1",
  });
  const mobileCrypto = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await keyStoreFor(mobileDeviceId, pairwiseKey),
    random: new FixedRandom(8),
    now: () => 1_800_000_000_000n,
  });

  const plaintext = new Uint8Array([1, 2, 3]);
  const item = await hostCrypto.seal(mobileDeviceId, plaintext);
  expect(item.messageId).toBe("message-1");

  const outbound = outboundEnvelopeFromUnknown(item.encrypted, (message) => new Error(message));
  expect(outbound.senderDeviceId).toBe(hostDeviceId);
  expect(outbound.recipientDeviceId).toBe(mobileDeviceId);
  expect(outbound.routeId).toBe(routeId);

  const opened = await mobileCrypto.open(inbound(item.encrypted));
  expect(opened).toEqual(plaintext);
});

test("clientSequence increases monotonically across seal calls", async () => {
  const keyStore = await pairedKeyStore();
  const crypto1 = new RouteEnvelopeCrypto({
    routeId,
    keyStore,
    random: new FixedRandom(1),
    now: () => 1n,
  });
  const first = await crypto1.seal("mobile-1", new Uint8Array([1]));
  const second = await crypto1.seal("mobile-1", new Uint8Array([2]));
  const third = await crypto1.seal("mobile-1", new Uint8Array([3]));
  expect(sequenceOf(first)).toBe(1n);
  expect(sequenceOf(second)).toBe(2n);
  expect(sequenceOf(third)).toBe(3n);
});

test("seal's default messageId is a deterministic content address, not a random id", async () => {
  const keyStore = await pairedKeyStore();
  const crypto1 = new RouteEnvelopeCrypto({ routeId, keyStore, random: new FixedRandom(1) });
  const crypto2 = new RouteEnvelopeCrypto({ routeId, keyStore, random: new FixedRandom(2) });

  // Same recipient + same plaintext (a retried enqueue of the same logical
  // message, e.g. after a restart) -> same messageId, even from a second
  // RouteEnvelopeCrypto instance with unrelated random/clientSequence state,
  // so ADR-006 dedup (Relay's sender_device_id + message_id, and the local
  // outbox's message_id PRIMARY KEY) actually collapses the retry.
  const plaintext = new Uint8Array([1, 2, 3]);
  const first = await crypto1.seal("mobile-1", plaintext);
  const second = await crypto2.seal("mobile-1", plaintext);
  expect(second.messageId).toBe(first.messageId);

  // Different plaintext to the same recipient -> different messageId.
  const differentPlaintext = await crypto1.seal("mobile-1", new Uint8Array([9, 9, 9]));
  expect(differentPlaintext.messageId).not.toBe(first.messageId);

  // Same plaintext to a different recipient -> different messageId (these
  // are two distinct deliveries, not a retry of the same one).
  const differentRecipient = await crypto1.seal("mobile-2", plaintext);
  expect(differentRecipient.messageId).not.toBe(first.messageId);
});

test("seal produces a fresh, injectable messageId on every call", async () => {
  const keyStore = await pairedKeyStore();
  let counter = 0;
  const crypto1 = new RouteEnvelopeCrypto({
    routeId,
    keyStore,
    random: new FixedRandom(1),
    now: () => 1n,
    newMessageId: () => `message-${(counter += 1)}`,
  });
  const first = await crypto1.seal("mobile-1", new Uint8Array([1]));
  const second = await crypto1.seal("mobile-1", new Uint8Array([1]));
  expect(first.messageId).toBe("message-1");
  expect(second.messageId).toBe("message-2");
});

test("seal rejects an empty recipientDeviceId", async () => {
  const keyStore = await pairedKeyStore();
  const crypto1 = new RouteEnvelopeCrypto({ routeId, keyStore, random: new FixedRandom(1) });
  expect(crypto1.seal("", new Uint8Array([1]))).rejects.toMatchObject({
    code: "INVALID_RECIPIENT",
  });
});

test("seal fails with a clear error when no pairwise key is stored for the route, without leaking any key material", async () => {
  const keyStore = new MemoryKeyStore();
  await keyStore.put(`route:${routeId}:host-id`, new TextEncoder().encode(hostDeviceId));
  const crypto1 = new RouteEnvelopeCrypto({ routeId, keyStore, random: new FixedRandom(1) });
  try {
    await crypto1.seal("mobile-1", new Uint8Array([1]));
    throw new Error("expected seal() to reject");
  } catch (error) {
    if (!(error instanceof HostEnvelopeCryptoError)) throw error;
    expect(error.code).toBe("MISSING_PAIRWISE_KEY");
    expect(error.message).not.toContain(Buffer.from(pairwiseKey).toString("base64"));
    expect(error.message).not.toContain(pairwiseKey.join(","));
  }
});

test("open fails when no host device id is stored for the route", async () => {
  const keyStore = new MemoryKeyStore();
  await keyStore.put(`route:${routeId}:pairwise-key`, pairwiseKey);
  const crypto1 = new RouteEnvelopeCrypto({ routeId, keyStore, random: new FixedRandom(1) });
  expect(crypto1.open(inbound({}))).rejects.toMatchObject({
    code: "MISSING_HOST_DEVICE_ID",
  });
});

test("open rejects an inbound envelope not addressed to this Host's device id", async () => {
  const senderKeyStore = await keyStoreFor("mobile-1", pairwiseKey);
  const sender = new RouteEnvelopeCrypto({
    routeId,
    keyStore: senderKeyStore,
    random: new FixedRandom(2),
    now: () => 1n,
  });
  const receiver = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await pairedKeyStore(),
    random: new FixedRandom(2),
  });

  const correctlyAddressed = await sender.seal(hostDeviceId, new Uint8Array([9]));
  expect(await receiver.open(inbound(correctlyAddressed.encrypted))).toEqual(new Uint8Array([9]));

  const misaddressed = await sender.seal("not-this-host", new Uint8Array([9]));
  expect(receiver.open(inbound(misaddressed.encrypted))).rejects.toMatchObject({
    code: "RECIPIENT_MISMATCH",
  });
});

test("open rejects an inbound payload that is not a sealed envelope", async () => {
  const keyStore = await pairedKeyStore();
  const crypto1 = new RouteEnvelopeCrypto({ routeId, keyStore, random: new FixedRandom(1) });
  expect(crypto1.open(inbound({ not: "an envelope" }))).rejects.toMatchObject({
    code: "INVALID_INBOUND_ENVELOPE",
  });
});

test("constructor rejects an empty routeId and a non-positive ttlMs", () => {
  const keyStore = new MemoryKeyStore();
  expect(
    () => new RouteEnvelopeCrypto({ routeId: "", keyStore, random: new FixedRandom(1) }),
  ).toThrow(HostEnvelopeCryptoError);
  expect(
    () => new RouteEnvelopeCrypto({ routeId, keyStore, random: new FixedRandom(1), ttlMs: 0n }),
  ).toThrow(HostEnvelopeCryptoError);
});

test("open surfaces AEAD authentication failures for a tampered ciphertext", async () => {
  const hostCrypto = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await pairedKeyStore(),
    random: new FixedRandom(3),
    now: () => 1n,
  });
  const mobileCrypto = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await keyStoreFor(mobileDeviceId, pairwiseKey),
    random: new FixedRandom(4),
    now: () => 1n,
  });
  const item = await mobileCrypto.seal(hostDeviceId, new Uint8Array([1, 2, 3]));
  const outbound = outboundEnvelopeFromUnknown(item.encrypted, (message) => new Error(message));
  const tamperedCiphertext = outbound.ciphertext.slice();
  tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1;
  const tampered = { ...outbound, ciphertext: tamperedCiphertext };
  try {
    await hostCrypto.open(inbound(tampered));
    throw new Error("expected open() to reject");
  } catch (error) {
    if (!(error instanceof CryptoContractError)) throw error;
    expect(error.code).toBe("AUTHENTICATION_FAILED");
  }
});

// Integration test: the three concrete host-adapters implementations
// (HostSqliteDeliveryStore, RouteEnvelopeCrypto, and a fake RelayGateway
// standing in for RouteRelayGateway/WorkerRelayClient) wired into
// HostRelayCoordinator (host-core), exercising enqueue -> flushOutbox and
// receive -> drainInbound end to end.

import { AEAD_KEY_BYTES, type RandomSource } from "@pocket-omp/crypto";
import {
  HostRelayCoordinator,
  type HostCommandDispatcher,
  type RelayGateway,
  type SecureKeyStore,
} from "@pocket-omp/host-core";
import { expect, test } from "bun:test";
import { HostSqliteDeliveryStore } from "../src/delivery-store";
import { RouteEnvelopeCrypto } from "../src/envelope-crypto";

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

class RecordingDispatcher implements HostCommandDispatcher {
  public readonly received: { readonly messageId: string; readonly plaintext: Uint8Array }[] = [];
  public async dispatch(messageId: string, plaintext: Uint8Array): Promise<void> {
    this.received.push({ messageId, plaintext });
  }
}

// Stands in for RouteRelayGateway/WorkerRelayClient: this test cares that
// HostRelayCoordinator's persist-then-publish / persist-then-dispatch-then-
// ack ordering holds when driven by real store + crypto adapters, not about
// the relay wire protocol itself (that is RouteRelayGateway's job, covered
// in relay-gateway.test.ts).
class FakeRelay implements RelayGateway {
  public readonly published: unknown[][] = [];
  public readonly acked: bigint[] = [];
  public frames: readonly { messageId: string; serverSequence: bigint; encrypted: unknown }[] = [];

  public async *subscribe(after: bigint, _signal: AbortSignal): AsyncIterable<unknown> {
    for (const frame of this.frames) if (frame.serverSequence > after) yield frame;
  }

  public async publish(envelopes: readonly unknown[]): Promise<unknown> {
    this.published.push([...envelopes]);
    return {};
  }

  public async acknowledge(sequence: bigint): Promise<void> {
    this.acked.push(sequence);
  }
}

const routeId = "route-1";
const hostDeviceId = "host-1";
const mobileDeviceId = "mobile-1";
const pairwiseKey = new Uint8Array(AEAD_KEY_BYTES).fill(0x77);

async function keyStoreFor(deviceId: string): Promise<MemoryKeyStore> {
  const keyStore = new MemoryKeyStore();
  await keyStore.put(`route:${routeId}:host-id`, new TextEncoder().encode(deviceId));
  await keyStore.put(`route:${routeId}:pairwise-key`, pairwiseKey);
  return keyStore;
}

test("enqueue -> flushOutbox persists before publish and drops only the published batch", async () => {
  const store = new HostSqliteDeliveryStore(":memory:");
  const crypto1 = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await keyStoreFor(hostDeviceId),
    random: new FixedRandom(1),
    now: () => 1_000n,
    newMessageId: () => "outbound-message-1",
  });
  const relay = new FakeRelay();
  const dispatcher = new RecordingDispatcher();
  const coordinator = new HostRelayCoordinator(relay, store, crypto1, dispatcher);

  const plaintext = new Uint8Array([1, 2, 3]);
  expect(await coordinator.enqueue(mobileDeviceId, plaintext)).toEqual({ duplicate: false });
  // Same injected messageId -> the SQLite store's PRIMARY KEY dedup fires.
  expect(await coordinator.enqueue(mobileDeviceId, plaintext)).toEqual({ duplicate: true });

  expect(await store.pendingOutbox(10)).toHaveLength(1);
  expect(await coordinator.flushOutbox()).toBe(1);
  expect(relay.published).toHaveLength(1);
  expect(relay.published[0]).toHaveLength(1);
  expect(await store.pendingOutbox(10)).toHaveLength(0);

  store.close();
});

test("receive -> drainInbound persists before dispatch, acks only after dispatch+cursor advance", async () => {
  const store = new HostSqliteDeliveryStore(":memory:");
  const hostCrypto = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await keyStoreFor(hostDeviceId),
    random: new FixedRandom(2),
    now: () => 2_000n,
  });
  // A second RouteEnvelopeCrypto instance plays Mobile's side purely to
  // produce a validly-sealed envelope addressed to the Host; it is not part
  // of the system under test.
  const mobileCrypto = new RouteEnvelopeCrypto({
    routeId,
    keyStore: await keyStoreFor(mobileDeviceId),
    random: new FixedRandom(3),
    now: () => 2_000n,
    newMessageId: () => "inbound-message-1",
  });
  const sealed = await mobileCrypto.seal(hostDeviceId, new Uint8Array([9, 8, 7]));

  const relay = new FakeRelay();
  relay.frames = [{ messageId: sealed.messageId, serverSequence: 1n, encrypted: sealed.encrypted }];
  const dispatcher = new RecordingDispatcher();
  const coordinator = new HostRelayCoordinator(relay, store, hostCrypto, dispatcher);

  expect(await store.relayCursor()).toBe(0n);
  await coordinator.receive(new AbortController().signal);

  expect(dispatcher.received).toEqual([
    { messageId: "inbound-message-1", plaintext: new Uint8Array([9, 8, 7]) },
  ]);
  expect(relay.acked).toEqual([1n]);
  expect(await store.relayCursor()).toBe(1n);
  expect(await store.pendingInbound(10)).toHaveLength(0);

  store.close();
});

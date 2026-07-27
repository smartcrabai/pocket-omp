import { expect, test } from "bun:test";
import {
  HostRelayCoordinator,
  type HostDeliveryStore,
  type HostInboundEnvelope,
  type HostOutboxItem,
  type RelayGateway,
} from "../src/index";

class MemoryStore implements HostDeliveryStore {
  public cursor = 0n;
  public readonly outbox = new Map<string, HostOutboxItem>();
  public readonly inbound = new Map<string, HostInboundEnvelope>();
  public readonly handled = new Set<string>();
  public async relayCursor(): Promise<bigint> {
    return this.cursor;
  }
  public async appendOutbox(item: HostOutboxItem): Promise<boolean> {
    if (this.outbox.has(item.messageId)) return false;
    this.outbox.set(item.messageId, item);
    return true;
  }
  public async pendingOutbox(limit: number): Promise<readonly HostOutboxItem[]> {
    return [...this.outbox.values()].slice(0, limit);
  }
  public async markOutboxPublished(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.outbox.delete(id);
  }
  public async persistInbound(envelope: HostInboundEnvelope): Promise<boolean> {
    if (this.inbound.has(envelope.messageId) || this.handled.has(envelope.messageId)) return false;
    this.inbound.set(envelope.messageId, envelope);
    return true;
  }
  public async pendingInbound(limit: number): Promise<readonly HostInboundEnvelope[]> {
    return [...this.inbound.values()].slice(0, limit);
  }
  public async markInboundHandled(id: string): Promise<void> {
    this.inbound.delete(id);
    this.handled.add(id);
  }
  public async advanceRelayCursor(sequence: bigint): Promise<void> {
    this.cursor = sequence;
  }
}

class FakeRelay implements RelayGateway {
  public readonly published: unknown[][] = [];
  public readonly acked: bigint[] = [];
  public frames: readonly unknown[] = [];
  public async *subscribe(after: bigint, _signal: AbortSignal): AsyncIterable<unknown> {
    for (const frame of this.frames) {
      if (
        typeof frame === "object" &&
        frame !== null &&
        "serverSequence" in frame &&
        typeof frame.serverSequence === "bigint" &&
        frame.serverSequence > after
      )
        yield frame;
    }
  }
  public async publish(envelopes: readonly unknown[]): Promise<unknown> {
    this.published.push([...envelopes]);
    return {};
  }
  public async acknowledge(sequence: bigint): Promise<void> {
    this.acked.push(sequence);
  }
}

const crypto = {
  seal: async (recipient: string, plaintext: Uint8Array): Promise<HostOutboxItem> => ({
    messageId: `${recipient}-${plaintext[0]}`,
    encrypted: plaintext.slice(),
  }),
  open: async (envelope: HostInboundEnvelope): Promise<Uint8Array> => {
    if (!(envelope.encrypted instanceof Uint8Array)) throw new Error("invalid test envelope");
    return envelope.encrypted.slice();
  },
};

test("Host outbox persists before publish and removes only published batches", async () => {
  const relay = new FakeRelay();
  const store = new MemoryStore();
  const coordinator = new HostRelayCoordinator(relay, store, crypto, {
    dispatch: async () => undefined,
  });
  expect(await coordinator.enqueue("mobile-1", new Uint8Array([7]))).toEqual({ duplicate: false });
  expect(await coordinator.enqueue("mobile-1", new Uint8Array([7]))).toEqual({ duplicate: true });
  expect(await coordinator.flushOutbox()).toBe(1);
  expect(relay.published).toHaveLength(1);
  expect(store.outbox.size).toBe(0);
});

test("Host inbox acknowledges only after durable dispatch and resumes pending work", async () => {
  const relay = new FakeRelay();
  relay.frames = [{ messageId: "message-1", serverSequence: 1n, encrypted: new Uint8Array([9]) }];
  const store = new MemoryStore();
  let fail = true;
  const delivered: string[] = [];
  const coordinator = new HostRelayCoordinator(relay, store, crypto, {
    dispatch: async (id) => {
      if (fail) throw new Error("runtime down");
      delivered.push(id);
    },
  });
  expect(coordinator.receive(new AbortController().signal)).rejects.toThrow("runtime down");
  expect(relay.acked).toEqual([]);
  expect(store.inbound.size).toBe(1);
  fail = false;
  expect(await coordinator.drainInbound()).toBe(1);
  expect(delivered).toEqual(["message-1"]);
  expect(relay.acked).toEqual([1n]);
  expect(store.cursor).toBe(1n);
});

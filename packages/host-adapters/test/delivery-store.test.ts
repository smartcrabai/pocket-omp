import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { HostSqliteDeliveryStore } from "../src/delivery-store";

function store(): HostSqliteDeliveryStore {
  return new HostSqliteDeliveryStore(":memory:");
}

test("relayCursor starts at zero and advances but never regresses", async () => {
  const db = store();
  expect(await db.relayCursor()).toBe(0n);
  await db.advanceRelayCursor(5n);
  expect(await db.relayCursor()).toBe(5n);
  await db.advanceRelayCursor(3n);
  expect(await db.relayCursor()).toBe(5n);
  await db.advanceRelayCursor(9n);
  expect(await db.relayCursor()).toBe(9n);
});

test("appendOutbox detects a duplicate messageId while pending", async () => {
  const db = store();
  const encrypted = { nonce: new Uint8Array([1, 2, 3]), sequence: 7n };
  expect(await db.appendOutbox({ messageId: "m1", encrypted })).toBe(true);
  expect(await db.appendOutbox({ messageId: "m1", encrypted })).toBe(false);
});

test("appendOutbox allows reusing a messageId once it has been published (matches host-core's reference fake)", async () => {
  const db = store();
  const encrypted = { n: 1n };
  expect(await db.appendOutbox({ messageId: "m1", encrypted })).toBe(true);
  await db.markOutboxPublished(["m1"]);
  expect(await db.appendOutbox({ messageId: "m1", encrypted })).toBe(true);
});

test("appendOutbox rejects an empty messageId", async () => {
  const db = store();
  expect(db.appendOutbox({ messageId: "", encrypted: {} })).rejects.toMatchObject({
    code: "INVALID_MESSAGE_ID",
  });
});

test("pendingOutbox returns items in insertion order and round-trips bigint/Uint8Array/number fields", async () => {
  const db = store();
  await db.appendOutbox({ messageId: "c", encrypted: { seq: 3n, bytes: new Uint8Array([7]) } });
  await db.appendOutbox({ messageId: "a", encrypted: { seq: 1n, bytes: new Uint8Array([1, 2]) } });
  await db.appendOutbox({ messageId: "b", encrypted: { seq: 2n, priority: 4 } });
  const pending = await db.pendingOutbox(10);
  expect(pending.map((item) => item.messageId)).toEqual(["c", "a", "b"]);
  expect(pending[0]?.encrypted).toEqual({ seq: 3n, bytes: new Uint8Array([7]) });
  expect(pending[2]?.encrypted).toEqual({ seq: 2n, priority: 4 });
});

test("pendingOutbox respects the limit boundary", async () => {
  const db = store();
  // Each store method resolves synchronously under the hood (bun:sqlite is
  // synchronous), so Promise.all here still inserts "a", "b", "c" in that
  // order; it just avoids awaiting sequentially inside a loop.
  await Promise.all(["a", "b", "c"].map((id) => db.appendOutbox({ messageId: id, encrypted: {} })));
  expect((await db.pendingOutbox(2)).map((item) => item.messageId)).toEqual(["a", "b"]);
  expect((await db.pendingOutbox(3)).map((item) => item.messageId)).toEqual(["a", "b", "c"]);
  expect((await db.pendingOutbox(100)).map((item) => item.messageId)).toEqual(["a", "b", "c"]);
});

test("pendingOutbox rejects invalid limits", async () => {
  const db = store();
  expect(db.pendingOutbox(0)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
  expect(db.pendingOutbox(-1)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
  expect(db.pendingOutbox(1.5)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
  expect(db.pendingOutbox(1_001)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
});

test("markOutboxPublished removes only the published items from pendingOutbox", async () => {
  const db = store();
  await db.appendOutbox({ messageId: "a", encrypted: {} });
  await db.appendOutbox({ messageId: "b", encrypted: {} });
  await db.appendOutbox({ messageId: "c", encrypted: {} });
  await db.markOutboxPublished(["a", "c"]);
  expect((await db.pendingOutbox(10)).map((item) => item.messageId)).toEqual(["b"]);
});

test("persistInbound detects duplicates both while pending and after being marked handled", async () => {
  const db = store();
  const envelope = { messageId: "m1", serverSequence: 1n, encrypted: { x: 1n } };
  expect(await db.persistInbound(envelope)).toBe(true);
  expect(await db.persistInbound(envelope)).toBe(false);
  await db.markInboundHandled("m1");
  // Unlike outbox, inbound messageIds are never eligible for reuse once
  // handled, defending against relay redelivery of an already-processed
  // message (ADR-006).
  expect(await db.persistInbound(envelope)).toBe(false);
});

test("persistInbound rejects a non-positive serverSequence", async () => {
  const db = store();
  expect(
    db.persistInbound({ messageId: "m1", serverSequence: 0n, encrypted: {} }),
  ).rejects.toMatchObject({ code: "INVALID_SEQUENCE" });
});

test("pendingInbound orders by server_sequence rather than insertion order, and excludes handled rows", async () => {
  const db = store();
  await db.persistInbound({ messageId: "c", serverSequence: 3n, encrypted: { n: 3 } });
  await db.persistInbound({ messageId: "a", serverSequence: 1n, encrypted: { n: 1 } });
  await db.persistInbound({ messageId: "b", serverSequence: 2n, encrypted: { n: 2 } });
  const pending = await db.pendingInbound(10);
  expect(pending.map((item) => item.messageId)).toEqual(["a", "b", "c"]);
  expect(pending.map((item) => item.serverSequence)).toEqual([1n, 2n, 3n]);

  await db.markInboundHandled("a");
  const remaining = await db.pendingInbound(10);
  expect(remaining.map((item) => item.messageId)).toEqual(["b", "c"]);
});

test("pendingInbound respects the limit boundary and rejects invalid limits", async () => {
  const db = store();
  await Promise.all(
    [1, 2, 3].map((index) =>
      db.persistInbound({ messageId: `m${index}`, serverSequence: BigInt(index), encrypted: {} }),
    ),
  );
  expect((await db.pendingInbound(2)).map((item) => item.messageId)).toEqual(["m1", "m2"]);
  expect(db.pendingInbound(0)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
  expect(db.pendingInbound(1_001)).rejects.toMatchObject({ code: "INVALID_LIMIT" });
});

test("appendOutbox rejects a non-object encrypted payload", async () => {
  const db = store();
  expect(db.appendOutbox({ messageId: "m1", encrypted: "not-an-object" })).rejects.toMatchObject({
    code: "INVALID_ENVELOPE",
  });
});

test("schema creation is idempotent and durable across repeated opens of the same file", async () => {
  const path = join(tmpdir(), `host-relay-store-${crypto.randomUUID()}.sqlite`);
  try {
    const first = new HostSqliteDeliveryStore(path);
    await first.appendOutbox({ messageId: "durable", encrypted: { n: 1n } });
    first.close();

    const second = new HostSqliteDeliveryStore(path);
    const pending = await second.pendingOutbox(10);
    expect(pending.map((item) => item.messageId)).toEqual(["durable"]);
    second.close();
  } finally {
    unlinkSync(path);
  }
});

import { expect, test } from "bun:test";
import {
  MobileStreamManager,
  applyProjectionEvent,
  emptyProjection,
  transitionStream,
  type MobileRelayFrame,
  type ProjectionState,
} from "../src/index";

test("stream state machine handles reconnect, reauthentication, background, and entitlement", () => {
  let state = transitionStream({ kind: "idle" }, { kind: "foregrounded" });
  state = transitionStream(state, { kind: "ticket-obtained", generation: "g1" });
  state = transitionStream(state, { kind: "connected", generation: "g1", cursor: 3n });
  state = transitionStream(state, { kind: "caught-up", generation: "g1", cursor: 3n });
  expect(state).toEqual({ kind: "live", generation: "g1", cursor: 3n });
  expect(transitionStream(state, { kind: "backgrounded", cursor: 3n })).toEqual({
    kind: "suspended",
    cursor: 3n,
  });
  expect(transitionStream(state, { kind: "ticket-expiring" })).toEqual({
    kind: "reauthenticating",
  });
  expect(transitionStream(state, { kind: "entitlement-lost" })).toEqual({
    kind: "entitlement-required",
  });
});

test("projection applies each event once and rejects stale session revisions", () => {
  const event = {
    eventId: "event-1",
    sessionId: "session-1",
    revision: 2n,
    kind: "message",
    payload: {},
  };
  const first = applyProjectionEvent(emptyProjection(), event);
  expect(first.applied).toBeTrue();
  expect(applyProjectionEvent(first.state, event).applied).toBeFalse();
  expect(
    applyProjectionEvent(first.state, { ...event, eventId: "event-2", revision: 1n }).applied,
  ).toBeFalse();
});

test("stream manager durably commits projection before acknowledging relay frames", async () => {
  const order: string[] = [];
  const frames: MobileRelayFrame[] = [
    { serverSequence: 5n, generation: "g1", eventId: "event-1", encrypted: { revision: 1n } },
    { serverSequence: 6n, generation: "g1", eventId: "event-1", encrypted: { revision: 1n } },
  ];
  let stored: { cursor: bigint; projection: ProjectionState } = {
    cursor: 4n,
    projection: emptyProjection(),
  };
  const manager = new MobileStreamManager(
    {
      issueTicket: async () => ({ ticket: "ticket", generation: "g1" }),
      subscribe: async function* () {
        for (const frame of frames) yield frame;
      },
      acknowledge: async (cursor) => {
        order.push(`ack:${cursor}`);
      },
    },
    {
      load: async () => stored,
      commit: async (cursor, projection) => {
        order.push(`commit:${cursor}`);
        stored = { cursor, projection };
      },
    },
    {
      open: async (frame) => {
        if (
          typeof frame.encrypted !== "object" ||
          frame.encrypted === null ||
          !("revision" in frame.encrypted) ||
          typeof frame.encrypted.revision !== "bigint"
        )
          throw new Error("invalid test frame");
        return {
          eventId: frame.eventId,
          sessionId: "session-1",
          revision: frame.encrypted.revision,
          kind: "message",
          payload: {},
        };
      },
    },
  );
  await manager.run(new AbortController().signal);
  expect(order).toEqual(["commit:5", "ack:5", "commit:6", "ack:6"]);
  expect(stored.projection.events).toHaveLength(1);
  expect(manager.state).toEqual({ kind: "live", generation: "g1", cursor: 6n });
});

test("stream manager skips a frame whose crypto.open() rejects instead of wedging the stream", async () => {
  const order: string[] = [];
  const frameErrors: unknown[] = [];
  const frames: MobileRelayFrame[] = [
    { serverSequence: 5n, generation: "g1", eventId: "event-1", encrypted: "poison" },
    { serverSequence: 6n, generation: "g1", eventId: "event-2", encrypted: "ok" },
  ];
  let stored: { cursor: bigint; projection: ProjectionState } = {
    cursor: 4n,
    projection: emptyProjection(),
  };
  const manager = new MobileStreamManager(
    {
      issueTicket: async () => ({ ticket: "ticket", generation: "g1" }),
      subscribe: async function* () {
        for (const frame of frames) yield frame;
      },
      acknowledge: async (cursor) => {
        order.push(`ack:${cursor}`);
      },
    },
    {
      load: async () => stored,
      commit: async (cursor, projection) => {
        order.push(`commit:${cursor}`);
        stored = { cursor, projection };
      },
    },
    {
      open: async (frame) => {
        if (frame.encrypted === "poison") throw new Error("tampered envelope");
        return {
          eventId: frame.eventId,
          sessionId: "session-1",
          revision: 1n,
          kind: "message",
          payload: {},
        };
      },
    },
    undefined,
    (error, frame) => frameErrors.push({ error, eventId: frame.eventId }),
  );
  await manager.run(new AbortController().signal);
  // The poisoned frame is skipped (no commit gains an event from it) but the
  // cursor still advances past it and the stream keeps running to the next,
  // decryptable frame -- a single bad message no longer wedges everything.
  expect(order).toEqual(["commit:5", "ack:5", "commit:6", "ack:6"]);
  expect(stored.cursor).toBe(6n);
  expect(stored.projection.events).toHaveLength(1);
  expect(stored.projection.events[0]?.eventId).toBe("event-2");
  expect(frameErrors).toHaveLength(1);
  expect(frameErrors[0]).toMatchObject({ eventId: "event-1" });
  expect(manager.state).toEqual({ kind: "live", generation: "g1", cursor: 6n });
});

test("stream manager tolerates a frame error with no onFrameError callback wired up", async () => {
  const frames: MobileRelayFrame[] = [
    { serverSequence: 5n, generation: "g1", eventId: "event-1", encrypted: "poison" },
  ];
  let stored: { cursor: bigint; projection: ProjectionState } = {
    cursor: 4n,
    projection: emptyProjection(),
  };
  const manager = new MobileStreamManager(
    {
      issueTicket: async () => ({ ticket: "ticket", generation: "g1" }),
      subscribe: async function* () {
        for (const frame of frames) yield frame;
      },
      acknowledge: async () => undefined,
    },
    {
      load: async () => stored,
      commit: async (cursor, projection) => {
        stored = { cursor, projection };
      },
    },
    { open: async () => Promise.reject(new Error("tampered envelope")) },
  );
  // Neither onState nor onFrameError is passed -- both default to a no-op,
  // so a frame error must not throw out of run() even with nothing wired up
  // to observe it.
  await manager.run(new AbortController().signal);
  expect(stored.cursor).toBe(5n);
});

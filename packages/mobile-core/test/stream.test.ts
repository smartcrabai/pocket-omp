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

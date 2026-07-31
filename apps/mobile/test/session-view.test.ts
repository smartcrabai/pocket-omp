import { describe, expect, test } from "bun:test";
import {
  applyProjectionEvent,
  emptyProjection,
  type ProjectionEvent,
  type ProjectionState,
} from "@pocket-omp/mobile-core";
import {
  deriveSessionCatalog,
  describeSessionEventKind,
  isOwnershipConflict,
  reconstructTranscript,
  sessionEventsFor,
  type TranscriptRow,
} from "../src/session-view";

function withEvents(events: Parameters<typeof applyProjectionEvent>[1][]): ProjectionState {
  let state = emptyProjection();
  for (const event of events) {
    state = applyProjectionEvent(state, event).state;
  }
  return state;
}

describe("deriveSessionCatalog", () => {
  test("reports not-fetched when no host-snapshot event has ever arrived", () => {
    expect(deriveSessionCatalog(emptyProjection())).toEqual({ status: "not-fetched" });
  });

  test("reports loaded with an empty list once a snapshot with zero sessions arrives", () => {
    const projection = withEvents([
      {
        eventId: "envelope-1",
        revision: 0n,
        kind: "host-snapshot",
        payload: { hostId: "host-1", displayName: "My Host", sessions: [] },
      },
    ]);
    expect(deriveSessionCatalog(projection)).toEqual({ status: "loaded", sessions: [] });
  });

  test("the newest of several host-snapshot events wins", () => {
    const stale = {
      sessionId: "session-1",
      title: "Stale",
      cwdDisplayName: "~/stale",
      updatedAtMs: 1n,
      compatibility: "fully-compatible",
      ownership: "idle",
    };
    const fresh = {
      sessionId: "session-2",
      title: "Fresh",
      cwdDisplayName: "~/fresh",
      updatedAtMs: 2n,
      compatibility: "fully-compatible",
      ownership: "pocket-owned",
    };
    const projection = withEvents([
      {
        eventId: "envelope-1",
        revision: 0n,
        kind: "host-snapshot",
        payload: { hostId: "host-1", displayName: "My Host", sessions: [stale] },
      },
      {
        eventId: "envelope-2",
        revision: 0n,
        kind: "host-snapshot",
        payload: { hostId: "host-1", displayName: "My Host", sessions: [fresh] },
      },
    ]);
    expect(deriveSessionCatalog(projection)).toEqual({ status: "loaded", sessions: [fresh] });
  });

  test("ignores payloads for other SecurePayload kinds even if shaped like a record", () => {
    const projection = withEvents([
      {
        eventId: "envelope-1",
        revision: 0n,
        kind: "command-result",
        payload: { commandId: "command-1", success: true, code: "OK", message: "" },
      },
    ]);
    expect(deriveSessionCatalog(projection)).toEqual({ status: "not-fetched" });
  });
});

describe("sessionEventsFor", () => {
  test("returns only the target session's events, in ascending revision order", () => {
    // Applied out of order on purpose (revision 3 arrives before revision 1 in
    // terms of when they're pushed into `events`, by feeding a second session's
    // event in between) to prove the sort -- not just underlying arrival order
    // -- is what determines the result.
    const projection = withEvents([
      { eventId: "e1", sessionId: "session-1", revision: 1n, kind: "message", payload: {} },
      { eventId: "e2", sessionId: "session-2", revision: 1n, kind: "message", payload: {} },
      { eventId: "e3", sessionId: "session-1", revision: 2n, kind: "message", payload: {} },
      { eventId: "e4", sessionId: "session-2", revision: 2n, kind: "message", payload: {} },
      { eventId: "e5", sessionId: "session-1", revision: 3n, kind: "message", payload: {} },
    ]);
    const events = sessionEventsFor(projection, "session-1");
    expect(events.map((event) => event.eventId)).toEqual(["e1", "e3", "e5"]);
    expect(events.every((event) => event.sessionId === "session-1")).toBeTrue();
  });

  test("never mixes in events for other sessions or session-less payloads", () => {
    const projection = withEvents([
      { eventId: "e1", sessionId: "session-1", revision: 1n, kind: "message", payload: {} },
      { eventId: "e2", sessionId: "session-2", revision: 1n, kind: "message", payload: {} },
      {
        eventId: "e3",
        revision: 0n,
        kind: "host-snapshot",
        payload: { hostId: "host-1", displayName: "Host", sessions: [] },
      },
    ]);
    const events = sessionEventsFor(projection, "session-1");
    expect(events).toHaveLength(1);
    expect(events[0]?.eventId).toBe("e1");
  });

  test("preserves bigint revisions exactly, without rounding through Number()", () => {
    // One greater than Number.MAX_SAFE_INTEGER: if revision were ever routed
    // through Number(), the two values below would collapse to the same
    // number and the sort/order assertion would silently pass either way.
    const huge = 9_007_199_254_740_993n;
    const hugePlusOne = 9_007_199_254_740_994n;
    const projection = withEvents([
      { eventId: "e1", sessionId: "session-1", revision: huge, kind: "message", payload: {} },
      {
        eventId: "e2",
        sessionId: "session-1",
        revision: hugePlusOne,
        kind: "message",
        payload: {},
      },
    ]);
    const events = sessionEventsFor(projection, "session-1");
    expect(events.map((event) => event.eventId)).toEqual(["e1", "e2"]);
    expect(typeof events[0]?.revision).toBe("bigint");
    expect(events[0]?.revision).toBe(huge);
    expect(events[1]?.revision).toBe(hugePlusOne);
  });

  test("returns an empty list for a session with no events yet", () => {
    expect(sessionEventsFor(emptyProjection(), "session-1")).toEqual([]);
  });
});

describe("isOwnershipConflict", () => {
  test("is true only for the conflict ownership state", () => {
    expect(isOwnershipConflict("conflict")).toBeTrue();
    expect(isOwnershipConflict("idle")).toBeFalse();
    expect(isOwnershipConflict("pocket-owned")).toBeFalse();
    expect(isOwnershipConflict("tui-owned")).toBeFalse();
  });
});

describe("describeSessionEventKind", () => {
  test("maps known AgentDomainEvent kinds to a human label", () => {
    expect(describeSessionEventKind("message-delta")).toBe("Message");
    expect(describeSessionEventKind("tool-started")).toBe("Tool call");
  });

  test("falls back to the raw kind for forward compatibility", () => {
    expect(describeSessionEventKind("a-future-kind")).toBe("a-future-kind");
  });
});

function buildEvent(
  overrides: Partial<ProjectionEvent> & { readonly eventId: string },
): ProjectionEvent {
  return { revision: 0n, kind: "unused", payload: undefined, ...overrides };
}

describe("reconstructTranscript", () => {
  test("concatenates interleaved message-delta events by messageId in revision order, even when fed out of order", () => {
    // Two messages' deltas interleaved, fed in a deliberately shuffled
    // order relative to their `revision` values, so only the function's own
    // defensive sort -- not array order -- can recover the right text.
    const events: ProjectionEvent[] = [
      buildEvent({
        eventId: "e4",
        revision: 4n,
        kind: "message-delta",
        payload: { kind: "message-delta", messageId: "msg-A", delta: "Hello, " },
      }),
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "message-started",
        payload: { kind: "message-started", messageId: "msg-A" },
      }),
      buildEvent({
        eventId: "e6",
        revision: 6n,
        kind: "message-delta",
        payload: { kind: "message-delta", messageId: "msg-B", delta: "wide." },
      }),
      buildEvent({
        eventId: "e2",
        revision: 2n,
        kind: "message-started",
        payload: { kind: "message-started", messageId: "msg-B" },
      }),
      buildEvent({
        eventId: "e3",
        revision: 3n,
        kind: "message-delta",
        payload: { kind: "message-delta", messageId: "msg-B", delta: "World " },
      }),
      buildEvent({
        eventId: "e8",
        revision: 8n,
        kind: "message-completed",
        payload: { kind: "message-completed", messageId: "msg-B" },
      }),
      buildEvent({
        eventId: "e5",
        revision: 5n,
        kind: "message-delta",
        payload: { kind: "message-delta", messageId: "msg-A", delta: "there!" },
      }),
      buildEvent({
        eventId: "e7",
        revision: 7n,
        kind: "message-completed",
        payload: { kind: "message-completed", messageId: "msg-A" },
      }),
    ];

    const rows = reconstructTranscript(events);
    const messageRows = rows.filter(
      (row): row is Extract<TranscriptRow, { kind: "message" }> => row.kind === "message",
    );
    expect(messageRows).toHaveLength(2);
    // msg-A's message-started (revision 1) is the earliest event of either
    // message, so its row comes first -- even though msg-B's own
    // message-started (revision 2) still precedes both of msg-A's deltas.
    expect(messageRows[0]).toMatchObject({ text: "Hello, there!", complete: true });
    expect(messageRows[1]).toMatchObject({ text: "World wide.", complete: true });
  });

  test("a message row appears (and stays incomplete) even if only deltas -- no message-started/-completed -- ever arrive", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "message-delta",
        payload: { kind: "message-delta", messageId: "msg-A", delta: "partial" },
      }),
    ]);
    expect(rows).toEqual([
      { key: "message:msg-A", kind: "message", text: "partial", complete: false },
    ]);
  });

  test("renders a tool-progress row with the tool name and phase", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "tool-updated",
        payload: {
          kind: "tool-updated",
          toolCallId: "call-1",
          toolName: "read_file",
          displayJson: '{"progress":0.5}',
        },
      }),
    ]);
    expect(rows).toEqual([{ key: "e1", kind: "tool", toolName: "read_file", phase: "updated" }]);
  });

  test("maps every TranscriptToolPhase to its row phase", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "tool-started",
        payload: { kind: "tool-started", toolCallId: "call-1", toolName: "read_file" },
      }),
      buildEvent({
        eventId: "e2",
        revision: 2n,
        kind: "tool-completed",
        payload: { kind: "tool-completed", toolCallId: "call-1", toolName: "read_file" },
      }),
    ]);
    expect(rows.map((row) => ("phase" in row ? row.phase : undefined))).toEqual([
      "started",
      "completed",
    ]);
  });

  test("maps every TranscriptAgentOutcome to its row outcome", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "agent-interrupted",
        payload: { kind: "agent-interrupted", runId: "run-1", reason: "user cancelled" },
      }),
    ]);
    expect(rows).toEqual([
      { key: "e1", kind: "agent-finished", outcome: "interrupted", reason: "user cancelled" },
    ]);
  });

  test("ignores a message-completed for a messageId with no prior row", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "message-completed",
        payload: { kind: "message-completed", messageId: "never-started" },
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test("renders a todo-updated row with its items and statuses", () => {
    const items = [
      { id: "1", text: "Write the spec", status: "completed" },
      { id: "2", text: "Ship it", status: "in-progress" },
    ];
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "todo-updated",
        payload: { kind: "todo-updated", items },
      }),
    ]);
    expect(rows).toEqual([{ key: "e1", kind: "todo", items }]);
  });

  test("renders an agent-finished row with the outcome and reason", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "agent-failed",
        payload: { kind: "agent-failed", runId: "run-1", reason: "OMP SDK crashed" },
      }),
    ]);
    expect(rows).toEqual([
      { key: "e1", kind: "agent-finished", outcome: "failed", reason: "OMP SDK crashed" },
    ]);
  });

  test("renders an agent-finished row without a reason field when none was given", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "agent-ended",
        payload: { kind: "agent-ended", runId: "run-1" },
      }),
    ]);
    expect(rows).toEqual([{ key: "e1", kind: "agent-finished", outcome: "ended" }]);
    expect("reason" in (rows[0] as object)).toBeFalse();
  });

  test("falls back to a plain label row for a recognized-but-not-yet-richly-rendered kind", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "agent-started",
        payload: { kind: "agent-started", runId: "run-1" },
      }),
    ]);
    expect(rows).toEqual([{ key: "e1", kind: "label", text: "Agent started" }]);
  });

  test("silently skips an unrecognized oneof case ('unknown') instead of rendering or throwing", () => {
    const rows = reconstructTranscript([
      buildEvent({
        eventId: "e1",
        revision: 1n,
        kind: "a-future-kind",
        payload: { kind: "unknown" },
      }),
    ]);
    expect(rows).toEqual([]);
  });

  test("skips a payload that isn't a decoded TranscriptEvent shape at all, without throwing", () => {
    const rows = reconstructTranscript([
      buildEvent({ eventId: "e1", revision: 1n, kind: "host-snapshot", payload: { sessions: [] } }),
      buildEvent({ eventId: "e2", revision: 2n, kind: "whatever", payload: undefined }),
    ]);
    expect(rows).toEqual([]);
  });

  test("returns an empty list for no events", () => {
    expect(reconstructTranscript([])).toEqual([]);
  });
});

import { commandId, eventId, sessionId } from "@pocket-omp/agent-domain";
import { describe, expect, test } from "bun:test";
import { encodeTranscriptEvent, type SecurePayloadBody } from "@pocket-omp/session-protocol";
import { toProjectionEvent } from "../src/relay-projection";

describe("toProjectionEvent", () => {
  test("maps a session-event with all fields, preserving the bigint revision exactly, and decodes its TranscriptEvent payload", () => {
    // One greater than Number.MAX_SAFE_INTEGER: if the revision were ever
    // routed through Number(), this value would silently change.
    const largeRevision = 9_007_199_254_740_993n;
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: {
        kind: "session-event",
        value: {
          eventId: eventId("event-1"),
          sessionId: sessionId("session-1"),
          revision: largeRevision,
          createdAtMs: 1_700_000_000_000n,
          runtimeGeneration: 3n,
          hostId: "host-1",
          kind: "message-completed",
          payload: encodeTranscriptEvent({ kind: "message-completed", messageId: "message-1" }),
        },
      },
    };
    const event = toProjectionEvent("envelope-message-id", body);
    expect(event.eventId).toBe("event-1");
    expect(event.sessionId).toBe("session-1");
    expect(typeof event.revision).toBe("bigint");
    expect(event.revision).toBe(largeRevision);
    expect(event.kind).toBe("message-completed");
    expect(event.payload).toEqual({ kind: "message-completed", messageId: "message-1" });
  });

  test("maps a session-event carrying an optional runId without losing other fields", () => {
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: {
        kind: "session-event",
        value: {
          eventId: eventId("event-2"),
          sessionId: sessionId("session-2"),
          revision: 5n,
          createdAtMs: 1_700_000_000_001n,
          runtimeGeneration: 1n,
          hostId: "host-1",
          kind: "tool-started",
          payload: encodeTranscriptEvent({
            kind: "tool-started",
            toolCallId: "call-1",
            toolName: "read_file",
          }),
        },
      },
    };
    const event = toProjectionEvent("envelope-message-id-2", body);
    expect(event).toEqual({
      eventId: "event-2",
      sessionId: "session-2",
      revision: 5n,
      kind: "tool-started",
      payload: { kind: "tool-started", toolCallId: "call-1", toolName: "read_file" },
    });
  });

  test("decodes an unrecognized session-event kind's TranscriptEvent to the unknown placeholder instead of throwing", () => {
    // An empty payload is a syntactically valid (but oneof-unset)
    // TranscriptEvent -- exactly what a future oneof case this build
    // doesn't recognize yet would also decode to (see
    // decodeTranscriptEvent's own forward-compatibility handling).
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: {
        kind: "session-event",
        value: {
          eventId: eventId("event-9"),
          sessionId: sessionId("session-9"),
          revision: 1n,
          createdAtMs: 0n,
          runtimeGeneration: 0n,
          hostId: "host-1",
          kind: "a-future-kind",
          payload: new Uint8Array(),
        },
      },
    };
    const event = toProjectionEvent("envelope-message-id-9", body);
    expect(event.payload).toEqual({ kind: "unknown" });
  });

  test("falls back to the envelope message id and omits sessionId for a host-snapshot payload", () => {
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: {
        kind: "host-snapshot",
        value: { hostId: "host-1", displayName: "My Host", sessions: [] },
      },
    };
    const event = toProjectionEvent("envelope-message-id-3", body);
    expect(event.eventId).toBe("envelope-message-id-3");
    expect(event.revision).toBe(0n);
    expect(event.kind).toBe("host-snapshot");
    expect(event.payload).toEqual({ hostId: "host-1", displayName: "My Host", sessions: [] });
    expect("sessionId" in event).toBeFalse();
  });

  test("passes through a command-result payload generically, keyed by the envelope message id", () => {
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: {
        kind: "command-result",
        value: {
          commandId: commandId("command-1"),
          success: false,
          code: "FAILED",
          message: "boom",
        },
      },
    };
    const event = toProjectionEvent("envelope-message-id-4", body);
    expect(event).toEqual({
      eventId: "envelope-message-id-4",
      revision: 0n,
      kind: "command-result",
      payload: { commandId: "command-1", success: false, code: "FAILED", message: "boom" },
    });
  });

  test("deduplicates non-session-event kinds by envelope message id, matching relay-level idempotency", () => {
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: {
        kind: "error",
        value: { code: "RATE_LIMITED", message: "slow down", retryable: true },
      },
    };
    const first = toProjectionEvent("same-message-id", body);
    const second = toProjectionEvent("same-message-id", body);
    expect(first.eventId).toBe(second.eventId);
  });
});

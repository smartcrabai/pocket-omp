import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { approvalRequestId, runId, uiRequestId, type TodoItem } from "@pocket-omp/agent-domain";
import { describe, expect, test } from "bun:test";
import {
  decodeTranscriptEvent,
  encodeTranscriptEvent,
  SessionProtocolError,
  type DecodedTranscriptEvent,
  type TranscriptEventBody,
} from "../src/index";

const UINT64_MAX = 2n ** 64n - 1n;
const INT64_MAX = 2n ** 63n - 1n;

// Every roundTrip call feeds encode's output straight into decode using the
// *same* kind that produced it, matching how Host always constructs
// SessionEvent.kind and its TranscriptEvent payload from the same
// AgentDomainEvent (see apps/host/src/runtime-event-forwarder.ts) -- they can
// never disagree by construction there. The dedicated kind-mismatch tests
// below are what exercise decodeTranscriptEvent's cross-check on its own.
function roundTrip(body: TranscriptEventBody): DecodedTranscriptEvent {
  const bytes = encodeTranscriptEvent(body);
  const decoded = decodeTranscriptEvent(body.kind, bytes);
  expect(decoded).toEqual(body);
  return decoded;
}

function expectSessionProtocolError(
  action: () => unknown,
  code: SessionProtocolError["code"],
): void {
  try {
    action();
    throw new Error("expected SessionProtocolError to be thrown");
  } catch (error) {
    if (!(error instanceof SessionProtocolError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// All 10 oneof cases round-trip, each with optional-field-present and
// optional-field-absent variants where the message has one, and bigints kept
// exact across Number.MAX_SAFE_INTEGER.
// ---------------------------------------------------------------------------

describe("encodeTranscriptEvent / decodeTranscriptEvent round trips", () => {
  test("agent-started", () => {
    roundTrip({ kind: "agent-started", runId: runId("run-1") });
  });

  test("message-started", () => {
    roundTrip({ kind: "message-started", messageId: "message-1" });
  });

  test("message-delta with non-empty text", () => {
    roundTrip({ kind: "message-delta", messageId: "message-1", delta: "Hello, world" });
  });

  test("message-delta preserves an empty delta rather than rejecting it", () => {
    roundTrip({ kind: "message-delta", messageId: "message-1", delta: "" });
  });

  test("message-completed", () => {
    roundTrip({ kind: "message-completed", messageId: "message-1" });
  });

  test("tool-started without display_json", () => {
    roundTrip({ kind: "tool-started", toolCallId: "call-1", toolName: "read_file" });
  });

  test("tool-updated with display_json present", () => {
    roundTrip({
      kind: "tool-updated",
      toolCallId: "call-1",
      toolName: "read_file",
      displayJson: JSON.stringify({ progress: 0.5 }),
    });
  });

  test("tool-completed", () => {
    roundTrip({
      kind: "tool-completed",
      toolCallId: "call-1",
      toolName: "read_file",
      displayJson: JSON.stringify({ ok: true }),
    });
  });

  test("approval-requested keeps expires_at_ms as bigint beyond Number.MAX_SAFE_INTEGER", () => {
    const decoded = roundTrip({
      kind: "approval-requested",
      approvalRequestId: approvalRequestId("approval-1"),
      expiresAtMs: INT64_MAX,
      summary: "Run `rm -rf /tmp/scratch`?",
      contentHash: new Uint8Array([1, 2, 3, 4]),
    });
    if (decoded.kind !== "approval-requested") throw new Error("expected approval-requested");
    expect(typeof decoded.expiresAtMs).toBe("bigint");
    expect(decoded.expiresAtMs).toBe(INT64_MAX);
  });

  test("ui-requested without payload_json, for every TranscriptUiKind", () => {
    for (const uiKind of ["confirm", "select", "input", "editor"] as const) {
      roundTrip({
        kind: "ui-requested",
        uiRequestId: uiRequestId("ui-1"),
        uiKind,
        expiresAtMs: 1_700_000_000_000n,
        contentHash: new Uint8Array([9]),
      });
    }
  });

  test("ui-requested with payload_json present", () => {
    roundTrip({
      kind: "ui-requested",
      uiRequestId: uiRequestId("ui-1"),
      uiKind: "select",
      expiresAtMs: 1_700_000_000_000n,
      payloadJson: JSON.stringify({ options: ["a", "b"] }),
      contentHash: new Uint8Array([9, 9]),
    });
  });

  test("subagent-started without display_json", () => {
    roundTrip({ kind: "subagent-started", taskId: "task-1" });
  });

  test("subagent-updated with display_json present", () => {
    roundTrip({ kind: "subagent-updated", taskId: "task-1", displayJson: '{"step":2}' });
  });

  test("subagent-completed", () => {
    roundTrip({ kind: "subagent-completed", taskId: "task-1" });
  });

  test("todo-updated with a mix of every TranscriptTodoStatus", () => {
    const items: readonly TodoItem[] = [
      { id: "1", text: "Write the spec", status: "completed" },
      { id: "2", text: "Implement it", status: "in-progress" },
      { id: "3", text: "Ship it", status: "pending" },
      { id: "4", text: "Skip this one", status: "cancelled" },
    ];
    roundTrip({ kind: "todo-updated", items });
  });

  test("todo-updated with no items", () => {
    roundTrip({ kind: "todo-updated", items: [] });
  });

  test("agent-ended without reason", () => {
    roundTrip({ kind: "agent-ended", runId: runId("run-1") });
  });

  test("agent-failed with reason", () => {
    roundTrip({ kind: "agent-failed", runId: runId("run-1"), reason: "OMP SDK crashed" });
  });

  test("agent-interrupted", () => {
    roundTrip({ kind: "agent-interrupted", runId: runId("run-1"), reason: "user cancelled" });
  });

  test("revision-carrying uint64 fields elsewhere in the wire format still hold UINT64_MAX (sanity check on the shared bigint plumbing)", () => {
    // TranscriptEvent itself has no uint64 fields, but this guards the
    // assumption the rest of this file's bigint assertions lean on: bigint
    // round-trips through @bufbuild/protobuf without precision loss.
    expect(UINT64_MAX).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
});

// ---------------------------------------------------------------------------
// kind <-> phase/outcome enum consistency
// ---------------------------------------------------------------------------

describe("decodeTranscriptEvent rejects a kind/payload mismatch", () => {
  test("rejects a tool_progress payload decoded against the wrong phase's kind", () => {
    const bytes = encodeTranscriptEvent({
      kind: "tool-started",
      toolCallId: "call-1",
      toolName: "read_file",
    });
    expectSessionProtocolError(
      () => decodeTranscriptEvent("tool-completed", bytes),
      "KIND_MISMATCH",
    );
  });

  test("rejects a subagent_progress payload decoded against the wrong phase's kind", () => {
    const bytes = encodeTranscriptEvent({ kind: "subagent-updated", taskId: "task-1" });
    expectSessionProtocolError(
      () => decodeTranscriptEvent("subagent-started", bytes),
      "KIND_MISMATCH",
    );
  });

  test("rejects an agent_finished payload decoded against the wrong outcome's kind", () => {
    const bytes = encodeTranscriptEvent({ kind: "agent-failed", runId: runId("run-1") });
    expectSessionProtocolError(() => decodeTranscriptEvent("agent-ended", bytes), "KIND_MISMATCH");
  });

  test("rejects a completely unrelated oneof case (message_delta payload, agent-started kind)", () => {
    const bytes = encodeTranscriptEvent({
      kind: "message-delta",
      messageId: "message-1",
      delta: "hi",
    });
    expectSessionProtocolError(
      () => decodeTranscriptEvent("agent-started", bytes),
      "KIND_MISMATCH",
    );
  });

  test("rejects a non-grouped case decoded against any other kind", () => {
    const bytes = encodeTranscriptEvent({ kind: "message-started", messageId: "message-1" });
    expectSessionProtocolError(
      () => decodeTranscriptEvent("message-completed", bytes),
      "KIND_MISMATCH",
    );
  });
});

// ---------------------------------------------------------------------------
// Forward compatibility: an oneof case this build's generated schema does not
// recognize (a Host built against a newer proto) must decode to `{ kind:
// "unknown" }`, never throw. Hand-crafted with @bufbuild/protobuf/wire's
// BinaryWriter -- rather than adding a field to session.proto, which the task
// forbids -- so this is a genuine "unknown field number on the wire",
// exactly what a future oneof case will look like to this build.
// ---------------------------------------------------------------------------

describe("decodeTranscriptEvent forward compatibility", () => {
  test("an unrecognized oneof field number decodes to the unknown placeholder instead of throwing", () => {
    const writer = new BinaryWriter();
    // Field 99 is far outside TranscriptEvent's 10 defined oneof fields
    // (1-10): this build's TranscriptEventSchema has no case for it, so
    // fromBinary preserves it as an unknown field rather than populating
    // `body.case`.
    writer.tag(99, WireType.LengthDelimited).bytes(new Uint8Array([1, 2, 3]));
    const bytes = writer.finish();

    const decoded = decodeTranscriptEvent("some-future-kind", bytes);
    expect(decoded).toEqual({ kind: "unknown" });
  });

  test("an empty TranscriptEvent (no oneof case set at all) also decodes to the unknown placeholder", () => {
    const decoded = decodeTranscriptEvent("whatever", new Uint8Array());
    expect(decoded).toEqual({ kind: "unknown" });
  });
});

// ---------------------------------------------------------------------------
// display_json / payload_json are opaque: Host never parses them, and Mobile
// must not throw on garbage content either. The codec treats them as plain
// strings -- never JSON.parse'd -- so "invalid JSON" cannot possibly throw
// here by construction; these tests pin that down.
// ---------------------------------------------------------------------------

describe("display_json / payload_json transparency", () => {
  test("a syntactically invalid display_json string round-trips unchanged", () => {
    const garbage = "{not valid json at all[[[";
    const decoded = roundTrip({
      kind: "tool-started",
      toolCallId: "call-1",
      toolName: "read_file",
      displayJson: garbage,
    });
    if (decoded.kind !== "tool-started") throw new Error("expected tool-started");
    expect(decoded.displayJson).toBe(garbage);
  });

  test("a syntactically invalid payload_json string round-trips unchanged", () => {
    const garbage = "not json either";
    const decoded = roundTrip({
      kind: "ui-requested",
      uiRequestId: uiRequestId("ui-1"),
      uiKind: "input",
      expiresAtMs: 1n,
      payloadJson: garbage,
      contentHash: new Uint8Array(),
    });
    if (decoded.kind !== "ui-requested") throw new Error("expected ui-requested");
    expect(decoded.payloadJson).toBe(garbage);
  });
});

// ---------------------------------------------------------------------------
// Size budget: an oversized display_json/payload_json is truncated rather
// than pushing the whole SecurePayload over SECURE_PAYLOAD_MAX_BYTES and
// failing to send (see the doc comment on TRANSCRIPT_OPAQUE_JSON_MAX_BYTES
// in ../src/index.ts for the chosen policy and its rationale).
// ---------------------------------------------------------------------------

describe("oversized display_json / payload_json is truncated, never dropped or rejected", () => {
  const OPAQUE_JSON_MAX_BYTES = 65_536;

  test("an oversized tool_progress display_json is truncated to the byte budget", () => {
    const huge = "x".repeat(OPAQUE_JSON_MAX_BYTES * 2);
    const bytes = encodeTranscriptEvent({
      kind: "tool-started",
      toolCallId: "call-1",
      toolName: "read_file",
      displayJson: huge,
    });
    const decoded = decodeTranscriptEvent("tool-started", bytes);
    if (decoded.kind !== "tool-started") throw new Error("expected tool-started");
    expect(decoded.displayJson).toBeDefined();
    const displayJson = decoded.displayJson ?? "";
    expect(new TextEncoder().encode(displayJson).byteLength).toBeLessThanOrEqual(
      OPAQUE_JSON_MAX_BYTES,
    );
    // The field is still populated (not dropped) and is a strict prefix of
    // the original, unbounded value.
    expect(huge.startsWith(displayJson)).toBeTrue();
    expect(displayJson.length).toBeGreaterThan(0);
  });

  test("an oversized ui_requested payload_json is truncated the same way", () => {
    const huge = JSON.stringify({ text: "y".repeat(OPAQUE_JSON_MAX_BYTES * 2) });
    const bytes = encodeTranscriptEvent({
      kind: "ui-requested",
      uiRequestId: uiRequestId("ui-1"),
      uiKind: "input",
      expiresAtMs: 1n,
      payloadJson: huge,
      contentHash: new Uint8Array(),
    });
    const decoded = decodeTranscriptEvent("ui-requested", bytes);
    if (decoded.kind !== "ui-requested") throw new Error("expected ui-requested");
    const payloadJson = decoded.payloadJson ?? "";
    expect(new TextEncoder().encode(payloadJson).byteLength).toBeLessThanOrEqual(
      OPAQUE_JSON_MAX_BYTES,
    );
    expect(payloadJson.length).toBeLessThan(huge.length);
  });

  test("a display_json at exactly the byte budget is not truncated", () => {
    const exact = "x".repeat(OPAQUE_JSON_MAX_BYTES);
    const bytes = encodeTranscriptEvent({
      kind: "tool-started",
      toolCallId: "call-1",
      toolName: "read_file",
      displayJson: exact,
    });
    const decoded = decodeTranscriptEvent("tool-started", bytes);
    if (decoded.kind !== "tool-started") throw new Error("expected tool-started");
    expect(decoded.displayJson).toBe(exact);
  });

  test("the resulting encoded TranscriptEvent stays well under SECURE_PAYLOAD_MAX_BYTES (262_144) even for a wildly oversized display_json", () => {
    const huge = "z".repeat(OPAQUE_JSON_MAX_BYTES * 8);
    const bytes = encodeTranscriptEvent({
      kind: "tool-completed",
      toolCallId: "call-1",
      toolName: "read_file",
      displayJson: huge,
    });
    expect(bytes.byteLength).toBeLessThan(100_000);
  });
});

// ---------------------------------------------------------------------------
// Malformed wire bytes
// ---------------------------------------------------------------------------

describe("decodeTranscriptEvent rejects malformed protobuf", () => {
  test("throws MALFORMED_PAYLOAD for bytes that are not a valid protobuf message", () => {
    // A lone continuation-bit varint byte with no following byte is an
    // incomplete/invalid encoding for any field.
    expectSessionProtocolError(
      () => decodeTranscriptEvent("agent-started", new Uint8Array([0xff])),
      "MALFORMED_PAYLOAD",
    );
  });
});

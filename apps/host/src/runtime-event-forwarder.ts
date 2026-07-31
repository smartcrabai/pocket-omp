// Converts an Agent Runtime `event` frame (apps/host/src/runtime-server.ts's
// RuntimeEvent: `{ eventId, kind, payload }`, where `payload` is
// `JSON.stringify(event, jsonReplacer)` over the full AgentDomainEvent --
// packages/agent-domain's EventMetadata plus its kind-specific fields) into
// a session-protocol SessionEvent, and hands it to a HostRelayCoordinator to
// forward toward the paired Mobile device.
//
// Field provenance (see runtime-server.ts's jsonReplacer/#forwardEvents and
// packages/agent-domain's EventMetadata for the exact wire shape this
// decodes):
//   - eventId/kind come off the RuntimeEvent frame's own dedicated fields
//     (already validated non-empty strings by the Runtime side's identifier()
//     brand constructors before being sent).
//   - sessionId/runId/revision/createdAtMs/runtimeGeneration/
//     causationCommandId are NOT part of the RuntimeEvent frame itself (only
//     event_id/kind/payload are, per proto/pocket/omp/runtime/v1/runtime.proto)
//     -- they only exist inside the JSON-encoded payload, so they are parsed
//     out of it here. jsonReplacer stringifies every bigint and this parser
//     reverses exactly that for the metadata fields (revision, createdAtMs,
//     runtimeGeneration): they are read back as bigint and never rounded
//     through `number`.
//   - SessionEvent.payload is no longer the RuntimeEvent's raw JSON bytes.
//     Mobile ships through app stores and can lag Host by months (see the
//     doc comment on TranscriptEvent in
//     proto/pocket/omp/session/v1/session.proto for the full reasoning), so
//     the kind-specific remainder of the JSON payload is parsed into a
//     session-protocol TranscriptEventBody and re-encoded as that versioned
//     Protobuf message via encodeTranscriptEvent -- field numbers, not JSON
//     object shape, are what carries forward/backward compatibility across
//     that boundary.
//   - ownershipEpoch (packages/host-core's OwnershipState) is omitted:
//     HostDaemon does not yet track ownership state (ADR-020's state
//     machine is not wired into host-daemon.ts), so there is nothing correct
//     to put there yet. A follow-up task integrating ownership tracking
//     should populate it.
import {
  approvalRequestId,
  commandId,
  eventId,
  runId,
  sessionId,
  uiRequestId,
  type CommandId,
  type RunId,
  type SessionId,
  type TodoItem,
} from "@pocket-omp/agent-domain";
import type { HostRelayCoordinator } from "@pocket-omp/host-core";
import {
  encodeSecurePayload,
  encodeTranscriptEvent,
  type SessionEvent,
  type TranscriptEventBody,
} from "@pocket-omp/session-protocol";

// Mirrors the "v1" convention already used elsewhere for this field (see
// apps/mobile's relay-crypto/relay-projection/mobile-stream-integration
// tests); capabilitySet is not yet interpreted by either side.
const SESSION_EVENT_CAPABILITY_SET = "v1";

export interface RuntimeEventFrame {
  readonly eventId: string;
  readonly kind: string;
  readonly payload: Uint8Array;
}

export interface RuntimeEventRelay {
  /** Only the method this module actually calls, so tests can inject a lightweight fake instead of a real HostRelayCoordinator. */
  readonly coordinator: Pick<HostRelayCoordinator, "enqueue">;
  /** This route's own Host device id (SecureKeyStore's `route:<routeId>:host-id`, see apps/host/src/pairing.ts). */
  readonly hostId: string;
  /** Resolves the paired Mobile device id to address outbound events to. Returns undefined when it is not known yet (see apps/host/src/recipient-device-id-learner.ts for how/when it becomes known). */
  readonly recipientDeviceId: () => string | undefined;
  /** Observes a forwarding failure for logging/testing. Forwarding failures never throw out of forwardRuntimeEvent regardless of whether this is provided. */
  readonly onForwardError?: (error: unknown) => void;
}

/**
 * Forwards one Runtime `event` frame toward Relay. A no-op when `relay` is
 * undefined (event forwarding is a purely optional path -- see
 * HostDaemonOptions.relay), and never throws: any failure (no relay wired,
 * no recipient known yet, a malformed event payload, Relay/store/crypto
 * failures) is reported via `relay.onForwardError` instead, so a forwarding
 * problem can never take down the Host Daemon or the frame reader loop that
 * calls this.
 */
export async function forwardRuntimeEvent(
  frame: RuntimeEventFrame,
  relay: RuntimeEventRelay | undefined,
): Promise<void> {
  if (relay === undefined) return;
  try {
    const recipientDeviceId = relay.recipientDeviceId();
    if (recipientDeviceId === undefined || recipientDeviceId.length === 0) {
      throw new RuntimeEventForwarderError(
        "NO_RECIPIENT",
        "No recipient device id is known yet for this route",
      );
    }
    const sessionEvent = buildSessionEvent(relay.hostId, frame);
    const plaintext = encodeSecurePayload({
      capabilitySet: SESSION_EVENT_CAPABILITY_SET,
      body: { kind: "session-event", value: sessionEvent },
    });
    await relay.coordinator.enqueue(recipientDeviceId, plaintext);
  } catch (error) {
    relay.onForwardError?.(error);
  }
}

export function buildSessionEvent(hostId: string, frame: RuntimeEventFrame): SessionEvent {
  const record = jsonObject(frame.payload);
  const metadata = parseAgentDomainEventMetadata(record);
  const transcriptBody = parseTranscriptEventBody(frame.kind, record);
  return {
    eventId: eventId(frame.eventId),
    sessionId: metadata.sessionId,
    ...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
    revision: metadata.revision,
    createdAtMs: metadata.createdAtMs,
    ...(metadata.causationCommandId === undefined
      ? {}
      : { causationCommandId: metadata.causationCommandId }),
    runtimeGeneration: metadata.runtimeGeneration,
    hostId,
    kind: frame.kind,
    payload: encodeTranscriptEvent(transcriptBody),
  };
}

interface AgentDomainEventMetadata {
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly revision: bigint;
  readonly createdAtMs: bigint;
  readonly runtimeGeneration: bigint;
  readonly causationCommandId?: CommandId;
}

function parseAgentDomainEventMetadata(record: object): AgentDomainEventMetadata {
  const rawRunId = optionalStringField(record, "runId");
  const rawCausationCommandId = optionalStringField(record, "causationCommandId");
  return {
    sessionId: sessionId(stringField(record, "sessionId")),
    ...(rawRunId === undefined ? {} : { runId: runId(rawRunId) }),
    revision: bigintField(record, "revision"),
    createdAtMs: bigintField(record, "createdAtMs"),
    runtimeGeneration: bigintField(record, "runtimeGeneration"),
    ...(rawCausationCommandId === undefined
      ? {}
      : { causationCommandId: commandId(rawCausationCommandId) }),
  };
}

// Converts the kind-specific remainder of a parsed AgentDomainEvent JSON
// object into a session-protocol TranscriptEventBody -- the per-kind mirror
// of parseAgentDomainEventMetadata above, which only handles the
// EventMetadata fields every kind shares. `kind` is frame.kind (the same
// string SessionEvent.kind is set to), so the two can never disagree here;
// decodeTranscriptEvent's own cross-check on the Mobile side exists for the
// wire boundary, not this same-process construction.
//
// Content fields that are free-form text rather than identifiers (delta,
// summary, reason) accept an empty string rather than rejecting it: Runtime
// is trusted (Host and Runtime ship as one atomic release -- see the proto
// file's doc comment), so there is no security reason to be stricter here
// than agent-domain's own AgentDomainEvent type is, and rejecting a
// legitimate empty fragment would drop real transcript content for no
// benefit. True identifiers (messageId, toolCallId, toolName, taskId, plus
// the branded runId/approvalRequestId/uiRequestId) still go through
// stringField, which rejects empty strings.
function parseTranscriptEventBody(kind: string, record: object): TranscriptEventBody {
  switch (kind) {
    case "agent-started":
      return { kind: "agent-started", runId: runId(stringField(record, "runId")) };
    case "message-started":
      return { kind: "message-started", messageId: stringField(record, "messageId") };
    case "message-delta":
      return {
        kind: "message-delta",
        messageId: stringField(record, "messageId"),
        delta: contentStringField(record, "delta"),
      };
    case "message-completed":
      return { kind: "message-completed", messageId: stringField(record, "messageId") };
    case "tool-started":
    case "tool-updated":
    case "tool-completed": {
      const displayJson = optionalJsonField(record, "display");
      return {
        kind,
        toolCallId: stringField(record, "toolCallId"),
        toolName: stringField(record, "toolName"),
        ...(displayJson === undefined ? {} : { displayJson }),
      };
    }
    case "approval-requested":
      return {
        kind: "approval-requested",
        approvalRequestId: approvalRequestId(stringField(record, "approvalRequestId")),
        expiresAtMs: bigintField(record, "expiresAtMs"),
        summary: contentStringField(record, "summary"),
        contentHash: base64ObjectField(record, "contentHash"),
      };
    case "ui-requested": {
      const payloadJson = optionalJsonField(record, "payload");
      return {
        kind: "ui-requested",
        uiRequestId: uiRequestId(stringField(record, "uiRequestId")),
        uiKind: uiKindField(record, "uiKind"),
        expiresAtMs: bigintField(record, "expiresAtMs"),
        ...(payloadJson === undefined ? {} : { payloadJson }),
        contentHash: base64ObjectField(record, "contentHash"),
      };
    }
    case "subagent-started":
    case "subagent-updated":
    case "subagent-completed": {
      const displayJson = optionalJsonField(record, "display");
      return {
        kind,
        taskId: stringField(record, "taskId"),
        ...(displayJson === undefined ? {} : { displayJson }),
      };
    }
    case "todo-updated":
      return { kind: "todo-updated", items: todoItemsField(record, "items") };
    case "agent-ended":
    case "agent-failed":
    case "agent-interrupted": {
      const reason = optionalStringField(record, "reason");
      return {
        kind,
        runId: runId(stringField(record, "runId")),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    default:
      throw new RuntimeEventForwarderError(
        "MALFORMED_EVENT",
        `Unsupported Runtime event kind ${JSON.stringify(kind)}`,
      );
  }
}

function uiKindField(record: object, name: string): "confirm" | "select" | "input" | "editor" {
  const value = stringField(record, name);
  if (value === "confirm" || value === "select" || value === "input" || value === "editor") {
    return value;
  }
  throw new RuntimeEventForwarderError(
    "MALFORMED_EVENT",
    `Runtime event payload field ${name} has an unsupported value ${JSON.stringify(value)}`,
  );
}

function todoItemsField(record: object, name: string): readonly TodoItem[] {
  const field = Reflect.get(record, name);
  if (!Array.isArray(field)) {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      `Runtime event payload field ${name} must be an array`,
    );
  }
  return field.map((item: unknown) => todoItemField(item));
}

function todoItemField(value: unknown): TodoItem {
  if (typeof value !== "object" || value === null) {
    throw new RuntimeEventForwarderError("MALFORMED_EVENT", "Todo item must be an object");
  }
  return {
    id: stringField(value, "id"),
    text: contentStringField(value, "text"),
    status: todoStatusField(value, "status"),
  };
}

function todoStatusField(record: object, name: string): TodoItem["status"] {
  const value = stringField(record, name);
  if (
    value === "pending" ||
    value === "in-progress" ||
    value === "completed" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new RuntimeEventForwarderError(
    "MALFORMED_EVENT",
    `Todo item field ${name} has an unsupported value ${JSON.stringify(value)}`,
  );
}

// Content fields (message deltas, approval summaries, finish reasons, todo
// text) legitimately can be empty strings; unlike stringField below, this
// only checks the JSON type, not its length.
function contentStringField(value: object, name: string): string {
  const field = Reflect.get(value, name);
  if (typeof field !== "string") {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      `Runtime event payload field ${name} must be a string`,
    );
  }
  return field;
}

// TranscriptToolProgress.display_json / TranscriptUiRequested.payload_json
// carry an OMP SDK rendering/request structure that AgentDomainEvent types as
// `unknown` (see the proto file's doc comment); Host never interprets it,
// only re-serializes whatever JSON.parse already reconstructed for it back
// into a string, verbatim. A missing key (jsonReplacer/JSON.stringify omit
// object properties whose value is `undefined`) means "no display/payload
// was produced for this event" and maps to `undefined` here, matching the
// proto field's own `optional` presence.
function optionalJsonField(record: object, name: string): string | undefined {
  if (!Reflect.has(record, name)) return undefined;
  return JSON.stringify(Reflect.get(record, name));
}

// jsonReplacer (runtime-server.ts) encodes a Uint8Array as `{ base64: "..." }`;
// this reverses exactly that for contentHash fields.
function base64ObjectField(record: object, name: string): Uint8Array {
  const field = Reflect.get(record, name);
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      `Runtime event payload field ${name} must be an object`,
    );
  }
  const base64 = Reflect.get(field, "base64");
  if (typeof base64 !== "string") {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      `Runtime event payload field ${name}.base64 must be a string`,
    );
  }
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function jsonObject(bytes: Uint8Array): object {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      "Runtime event payload is not valid JSON",
      { cause: error },
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      "Runtime event payload must be a JSON object",
    );
  }
  return value;
}

function stringField(value: object, name: string): string {
  const field = Reflect.get(value, name);
  if (typeof field !== "string" || field.length === 0) {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      `Runtime event payload is missing ${name}`,
    );
  }
  return field;
}

function optionalStringField(value: object, name: string): string | undefined {
  const field = Reflect.get(value, name);
  if (field === undefined) return undefined;
  if (typeof field !== "string" || field.length === 0) {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      `Runtime event payload field ${name} must be a non-empty string`,
    );
  }
  return field;
}

function bigintField(value: object, name: string): bigint {
  const field = Reflect.get(value, name);
  if (typeof field !== "string" || !/^\d+$/.test(field)) {
    throw new RuntimeEventForwarderError(
      "MALFORMED_EVENT",
      `Runtime event payload field ${name} must be a stringified non-negative integer`,
    );
  }
  return BigInt(field);
}

export class RuntimeEventForwarderError extends Error {
  public constructor(
    public readonly code: "MALFORMED_EVENT" | "NO_RECIPIENT",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeEventForwarderError";
  }
}

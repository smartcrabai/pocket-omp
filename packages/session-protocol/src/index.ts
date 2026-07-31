import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type {
  ApprovalRequestId,
  CommandId,
  EventMetadata,
  RunId,
  SessionId,
  TodoItem,
  UiRequestId,
} from "@pocket-omp/agent-domain";
import {
  approvalRequestId as brandApprovalRequestId,
  commandId as brandCommandId,
  eventId as brandEventId,
  runId as brandRunId,
  sessionId as brandSessionId,
  uiRequestId as brandUiRequestId,
} from "@pocket-omp/agent-domain";
import {
  AEAD_KEY_BYTES,
  E2EE_PROTOCOL_VERSION,
  open as cryptoOpen,
  seal as cryptoSeal,
  type EnvelopeMetadata as CryptoEnvelopeMetadata,
  type RandomSource,
} from "@pocket-omp/crypto";
import {
  type DeliveredEnvelope as ProtoDeliveredEnvelope,
  type NotificationHint,
  type OutboundEnvelope as ProtoOutboundEnvelope,
  OutboundEnvelopeSchema,
  type Priority,
  type SealedEnvelope as ProtoSealedEnvelope,
} from "@pocket-omp/proto/relay/v1";
import {
  AbortAgentSchema,
  type ApprovalRequest as ProtoApprovalRequest,
  ApprovalRequestSchema,
  type ApprovalResponse as ProtoApprovalResponse,
  ApprovalResponseSchema,
  ArchiveSessionSchema,
  type AttachmentChunk as ProtoAttachmentChunk,
  AttachmentChunkSchema,
  type AttachmentManifest as ProtoAttachmentManifest,
  AttachmentManifestSchema,
  type ClientCommand as ProtoClientCommand,
  ClientCommandSchema,
  type CommandAccepted as ProtoCommandAccepted,
  CommandAcceptedSchema,
  type CommandResult as ProtoCommandResult,
  CommandResultSchema,
  CompactSessionSchema,
  type DeviceHello as ProtoDeviceHello,
  DeviceHelloSchema,
  ExecuteGitActionSchema,
  ForkSessionSchema,
  GetGitDiffSchema,
  type HostSnapshot as ProtoHostSnapshot,
  HostSnapshotSchema,
  ListFilesSchema,
  ListSessionsSchema,
  QueueFollowUpSchema,
  ReadFileSchema,
  RefreshSessionCatalogSchema,
  ResumeSessionSchema,
  RespondToApprovalSchema,
  RespondToUiSchema,
  SearchSessionsSchema,
  type SecureError as ProtoSecureError,
  SecureErrorSchema,
  type SecurePayload as ProtoSecurePayload,
  SecurePayloadSchema,
  type SessionEvent as ProtoSessionEvent,
  SessionEventSchema,
  type SessionSnapshot as ProtoSessionSnapshot,
  SessionSnapshotSchema,
  type SessionSummary as ProtoSessionSummary,
  SessionSummarySchema,
  SetModelSchema,
  SetThinkingLevelSchema,
  StartSessionSchema,
  SteerAgentSchema,
  SubmitPromptSchema,
  TranscriptAgentFinishedSchema,
  TranscriptAgentOutcome,
  TranscriptAgentStartedSchema,
  TranscriptApprovalRequestedSchema,
  type TranscriptEvent as ProtoTranscriptEvent,
  TranscriptEventSchema,
  TranscriptMessageCompletedSchema,
  TranscriptMessageDeltaSchema,
  TranscriptMessageStartedSchema,
  TranscriptSubagentPhase,
  TranscriptSubagentProgressSchema,
  type TranscriptTodoItem as ProtoTranscriptTodoItem,
  TranscriptTodoItemSchema,
  TranscriptTodoStatus,
  TranscriptTodoUpdatedSchema,
  TranscriptToolPhase,
  TranscriptToolProgressSchema,
  TranscriptUiKind,
  TranscriptUiRequestedSchema,
  type UiRequest as ProtoUiRequest,
  UiRequestSchema,
  type UiResponse as ProtoUiResponse,
  UiResponseSchema,
} from "@pocket-omp/proto/session/v1";

export const SESSION_PROTOCOL_VERSION = 1;
export const SECURE_PAYLOAD_MAX_BYTES = 262_144;

// ---------------------------------------------------------------------------
// Domain representations. Generated Protobuf types never cross this module's
// public API surface (ADR-008); every exported shape below is a plain,
// readonly TypeScript type that Host/Mobile adapters can consume directly.
// ---------------------------------------------------------------------------

export interface DeviceHello {
  readonly deviceId: string;
  readonly deviceKind: string;
  readonly capabilities: readonly string[];
}

export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly title: string;
  readonly cwdDisplayName: string;
  readonly updatedAtMs: bigint;
  readonly compatibility: string;
  readonly ownership: string;
}

export interface HostSnapshot {
  readonly hostId: string;
  readonly displayName: string;
  readonly sessions: readonly SessionSummary[];
}

export interface SessionSnapshot {
  readonly sessionId: SessionId;
  readonly revision: bigint;
  readonly stateHash: string;
  readonly baseEventSequence: bigint;
  readonly projection: Uint8Array;
  readonly sessionFileId: string;
  readonly canonicalPathHash: string;
  readonly recordedCwd: string;
  readonly ownershipState: string;
  readonly ownershipEpoch: bigint;
  readonly compatibilityState: string;
  readonly sdkVersion: string;
  readonly tuiVersion: string;
  readonly sessionFormatVersion?: string;
  readonly runtimeGeneration: bigint;
  readonly activeRunState: string;
  readonly pendingInteractionCount: number;
  readonly lastStableFileFingerprint: string;
}

export interface SessionEvent extends EventMetadata {
  readonly hostId: string;
  readonly ownershipEpoch?: bigint;
  readonly kind: string;
  readonly payload: Uint8Array;
}

export type ClientCommandCase =
  | { readonly kind: "start-session"; readonly workspaceId: string }
  | { readonly kind: "resume-session"; readonly sessionId: SessionId }
  | {
      readonly kind: "submit-prompt";
      readonly text: string;
      readonly attachmentIds: readonly string[];
    }
  | { readonly kind: "steer-agent"; readonly text: string }
  | { readonly kind: "queue-follow-up"; readonly text: string }
  | { readonly kind: "abort-agent" }
  | {
      readonly kind: "respond-to-approval";
      readonly approvalRequestId: ApprovalRequestId;
      readonly allow: boolean;
      readonly displayedContentHash: Uint8Array;
    }
  | {
      readonly kind: "respond-to-ui";
      readonly uiRequestId: UiRequestId;
      readonly response: Uint8Array;
      readonly displayedContentHash: Uint8Array;
    }
  | { readonly kind: "set-model"; readonly provider: string; readonly modelId: string }
  | { readonly kind: "set-thinking-level"; readonly level: string }
  | { readonly kind: "compact-session" }
  | { readonly kind: "list-files"; readonly relativePath: string }
  | {
      readonly kind: "read-file";
      readonly relativePath: string;
      readonly offset: bigint;
      readonly limit: bigint;
    }
  | { readonly kind: "get-git-diff"; readonly staged: boolean }
  | {
      readonly kind: "execute-git-action";
      readonly action: string;
      readonly arguments: readonly string[];
      readonly displayedContentHash: Uint8Array;
    }
  | { readonly kind: "list-sessions" }
  | { readonly kind: "search-sessions"; readonly query: string }
  | { readonly kind: "fork-session"; readonly sourceSessionId: SessionId }
  | { readonly kind: "archive-session"; readonly sessionId: SessionId }
  | { readonly kind: "refresh-session-catalog" };

export interface ClientCommand {
  readonly commandId: CommandId;
  readonly sessionId?: SessionId;
  readonly issuedAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly command: ClientCommandCase;
}

export interface CommandAccepted {
  readonly commandId: CommandId;
  readonly runtimeId: string;
  readonly runtimeGeneration: bigint;
}

export interface CommandResult {
  readonly commandId: CommandId;
  readonly success: boolean;
  readonly code: string;
  readonly message: string;
}

export interface ApprovalRequest {
  readonly approvalRequestId: ApprovalRequestId;
  readonly sessionId: SessionId;
  readonly runtimeGeneration: bigint;
  readonly expiresAtMs: bigint;
  readonly kind: string;
  readonly summary: string;
  readonly contentHash: Uint8Array;
}

export interface ApprovalResponse {
  readonly approvalRequestId: ApprovalRequestId;
  readonly allow: boolean;
  readonly contentHash: Uint8Array;
}

export interface UiRequest {
  readonly uiRequestId: UiRequestId;
  readonly sessionId: SessionId;
  readonly runtimeGeneration: bigint;
  readonly expiresAtMs: bigint;
  readonly kind: string;
  readonly payload: Uint8Array;
  readonly contentHash: Uint8Array;
}

export interface UiResponse {
  readonly uiRequestId: UiRequestId;
  readonly payload: Uint8Array;
  readonly contentHash: Uint8Array;
}

export interface AttachmentChunk {
  readonly index: number;
  readonly nonce: Uint8Array;
  readonly ciphertextHash: Uint8Array;
  readonly ciphertextSize: bigint;
}

export interface AttachmentManifest {
  readonly objectId: string;
  readonly contentKey: Uint8Array;
  readonly plaintextHash: Uint8Array;
  readonly ciphertextHash: Uint8Array;
  readonly size: bigint;
  readonly mime: string;
  readonly fileName: string;
  readonly chunks: readonly AttachmentChunk[];
  readonly expiresAtMs: bigint;
}

export interface SecureError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type SecurePayloadCase =
  | { readonly kind: "device-hello"; readonly value: DeviceHello }
  | { readonly kind: "host-snapshot"; readonly value: HostSnapshot }
  | { readonly kind: "session-snapshot"; readonly value: SessionSnapshot }
  | { readonly kind: "session-event"; readonly value: SessionEvent }
  | { readonly kind: "command"; readonly value: ClientCommand }
  | { readonly kind: "command-accepted"; readonly value: CommandAccepted }
  | { readonly kind: "command-result"; readonly value: CommandResult }
  | { readonly kind: "approval-request"; readonly value: ApprovalRequest }
  | { readonly kind: "approval-response"; readonly value: ApprovalResponse }
  | { readonly kind: "ui-request"; readonly value: UiRequest }
  | { readonly kind: "ui-response"; readonly value: UiResponse }
  | { readonly kind: "attachment-manifest"; readonly value: AttachmentManifest }
  | { readonly kind: "error"; readonly value: SecureError };

export interface SecurePayloadBody {
  readonly capabilitySet: string;
  readonly body: SecurePayloadCase;
}

export class SessionProtocolError extends Error {
  public constructor(
    public readonly code:
      | "PROTOCOL_VERSION_MISMATCH"
      | "EMPTY_BODY"
      | "MALFORMED_PAYLOAD"
      | "PAYLOAD_TOO_LARGE"
      | "MISSING_REQUIRED_FIELD"
      | "INVALID_KEY_LENGTH"
      | "KIND_MISMATCH",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Public codec
// ---------------------------------------------------------------------------

export function encodeSecurePayload(payload: SecurePayloadBody): Uint8Array {
  const proto = create(SecurePayloadSchema, {
    protocolVersion: SESSION_PROTOCOL_VERSION,
    capabilitySet: payload.capabilitySet,
    body: toProtoSecurePayloadCase(payload.body),
  });
  const bytes = toBinary(SecurePayloadSchema, proto);
  if (bytes.byteLength > SECURE_PAYLOAD_MAX_BYTES) {
    throw new SessionProtocolError("PAYLOAD_TOO_LARGE", "SecurePayload exceeds the maximum size");
  }
  return bytes;
}

export function decodeSecurePayload(bytes: Uint8Array): SecurePayloadBody {
  if (bytes.byteLength === 0) {
    throw new SessionProtocolError("MALFORMED_PAYLOAD", "SecurePayload is empty");
  }
  if (bytes.byteLength > SECURE_PAYLOAD_MAX_BYTES) {
    throw new SessionProtocolError("PAYLOAD_TOO_LARGE", "SecurePayload exceeds the maximum size");
  }
  let proto: ProtoSecurePayload;
  try {
    proto = fromBinary(SecurePayloadSchema, bytes);
  } catch (error) {
    throw new SessionProtocolError("MALFORMED_PAYLOAD", "Invalid SecurePayload protobuf", {
      cause: error,
    });
  }
  if (proto.protocolVersion !== SESSION_PROTOCOL_VERSION) {
    throw new SessionProtocolError(
      "PROTOCOL_VERSION_MISMATCH",
      `Unsupported SecurePayload protocol version ${proto.protocolVersion}`,
    );
  }
  return {
    capabilitySet: proto.capabilitySet,
    body: fromProtoSecurePayloadCase(proto.body),
  };
}

// ---------------------------------------------------------------------------
// SecurePayload.body <-> SecurePayloadCase
// ---------------------------------------------------------------------------

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed SecurePayloadCase union; a new case fails to compile.
function toProtoSecurePayloadCase(body: SecurePayloadCase): ProtoSecurePayload["body"] {
  switch (body.kind) {
    case "device-hello":
      return { case: "deviceHello", value: toProtoDeviceHello(body.value) };
    case "host-snapshot":
      return { case: "hostSnapshot", value: toProtoHostSnapshot(body.value) };
    case "session-snapshot":
      return { case: "sessionSnapshot", value: toProtoSessionSnapshot(body.value) };
    case "session-event":
      return { case: "sessionEvent", value: toProtoSessionEvent(body.value) };
    case "command":
      return { case: "command", value: toProtoClientCommand(body.value) };
    case "command-accepted":
      return { case: "commandAccepted", value: toProtoCommandAccepted(body.value) };
    case "command-result":
      return { case: "commandResult", value: toProtoCommandResult(body.value) };
    case "approval-request":
      return { case: "approvalRequest", value: toProtoApprovalRequest(body.value) };
    case "approval-response":
      return { case: "approvalResponse", value: toProtoApprovalResponse(body.value) };
    case "ui-request":
      return { case: "uiRequest", value: toProtoUiRequest(body.value) };
    case "ui-response":
      return { case: "uiResponse", value: toProtoUiResponse(body.value) };
    case "attachment-manifest":
      return { case: "attachmentManifest", value: toProtoAttachmentManifest(body.value) };
    case "error":
      return { case: "error", value: toProtoSecureError(body.value) };
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the generated oneof case union (including "undefined", which throws).
function fromProtoSecurePayloadCase(body: ProtoSecurePayload["body"]): SecurePayloadCase {
  switch (body.case) {
    case "deviceHello":
      return { kind: "device-hello", value: fromProtoDeviceHello(body.value) };
    case "hostSnapshot":
      return { kind: "host-snapshot", value: fromProtoHostSnapshot(body.value) };
    case "sessionSnapshot":
      return { kind: "session-snapshot", value: fromProtoSessionSnapshot(body.value) };
    case "sessionEvent":
      return { kind: "session-event", value: fromProtoSessionEvent(body.value) };
    case "command":
      return { kind: "command", value: fromProtoClientCommand(body.value) };
    case "commandAccepted":
      return { kind: "command-accepted", value: fromProtoCommandAccepted(body.value) };
    case "commandResult":
      return { kind: "command-result", value: fromProtoCommandResult(body.value) };
    case "approvalRequest":
      return { kind: "approval-request", value: fromProtoApprovalRequest(body.value) };
    case "approvalResponse":
      return { kind: "approval-response", value: fromProtoApprovalResponse(body.value) };
    case "uiRequest":
      return { kind: "ui-request", value: fromProtoUiRequest(body.value) };
    case "uiResponse":
      return { kind: "ui-response", value: fromProtoUiResponse(body.value) };
    case "attachmentManifest":
      return { kind: "attachment-manifest", value: fromProtoAttachmentManifest(body.value) };
    case "error":
      return { kind: "error", value: fromProtoSecureError(body.value) };
    case undefined:
      throw new SessionProtocolError("EMPTY_BODY", "SecurePayload is missing a body");
  }
}

// ---------------------------------------------------------------------------
// DeviceHello
// ---------------------------------------------------------------------------

function toProtoDeviceHello(value: DeviceHello): ProtoDeviceHello {
  return create(DeviceHelloSchema, {
    deviceId: value.deviceId,
    deviceKind: value.deviceKind,
    capabilities: [...value.capabilities],
  });
}

function fromProtoDeviceHello(value: ProtoDeviceHello): DeviceHello {
  return {
    deviceId: value.deviceId,
    deviceKind: value.deviceKind,
    capabilities: [...value.capabilities],
  };
}

// ---------------------------------------------------------------------------
// SessionSummary / HostSnapshot
// ---------------------------------------------------------------------------

function toProtoSessionSummary(value: SessionSummary): ProtoSessionSummary {
  return create(SessionSummarySchema, {
    sessionId: value.sessionId,
    title: value.title,
    cwdDisplayName: value.cwdDisplayName,
    updatedAtMs: value.updatedAtMs,
    compatibility: value.compatibility,
    ownership: value.ownership,
  });
}

function fromProtoSessionSummary(value: ProtoSessionSummary): SessionSummary {
  return {
    sessionId: brandSessionId(value.sessionId),
    title: value.title,
    cwdDisplayName: value.cwdDisplayName,
    updatedAtMs: value.updatedAtMs,
    compatibility: value.compatibility,
    ownership: value.ownership,
  };
}

function toProtoHostSnapshot(value: HostSnapshot): ProtoHostSnapshot {
  return create(HostSnapshotSchema, {
    hostId: value.hostId,
    displayName: value.displayName,
    sessions: value.sessions.map(toProtoSessionSummary),
  });
}

function fromProtoHostSnapshot(value: ProtoHostSnapshot): HostSnapshot {
  return {
    hostId: value.hostId,
    displayName: value.displayName,
    sessions: value.sessions.map(fromProtoSessionSummary),
  };
}

// ---------------------------------------------------------------------------
// SessionSnapshot
// ---------------------------------------------------------------------------

function toProtoSessionSnapshot(value: SessionSnapshot): ProtoSessionSnapshot {
  return create(SessionSnapshotSchema, {
    sessionId: value.sessionId,
    revision: value.revision,
    stateHash: value.stateHash,
    baseEventSequence: value.baseEventSequence,
    projection: value.projection,
    sessionFileId: value.sessionFileId,
    canonicalPathHash: value.canonicalPathHash,
    recordedCwd: value.recordedCwd,
    ownershipState: value.ownershipState,
    ownershipEpoch: value.ownershipEpoch,
    compatibilityState: value.compatibilityState,
    sdkVersion: value.sdkVersion,
    tuiVersion: value.tuiVersion,
    ...(value.sessionFormatVersion === undefined
      ? {}
      : { sessionFormatVersion: value.sessionFormatVersion }),
    runtimeGeneration: value.runtimeGeneration,
    activeRunState: value.activeRunState,
    pendingInteractionCount: value.pendingInteractionCount,
    lastStableFileFingerprint: value.lastStableFileFingerprint,
  });
}

function fromProtoSessionSnapshot(value: ProtoSessionSnapshot): SessionSnapshot {
  return {
    sessionId: brandSessionId(value.sessionId),
    revision: value.revision,
    stateHash: value.stateHash,
    baseEventSequence: value.baseEventSequence,
    projection: value.projection,
    sessionFileId: value.sessionFileId,
    canonicalPathHash: value.canonicalPathHash,
    recordedCwd: value.recordedCwd,
    ownershipState: value.ownershipState,
    ownershipEpoch: value.ownershipEpoch,
    compatibilityState: value.compatibilityState,
    sdkVersion: value.sdkVersion,
    tuiVersion: value.tuiVersion,
    ...(value.sessionFormatVersion === undefined
      ? {}
      : { sessionFormatVersion: value.sessionFormatVersion }),
    runtimeGeneration: value.runtimeGeneration,
    activeRunState: value.activeRunState,
    pendingInteractionCount: value.pendingInteractionCount,
    lastStableFileFingerprint: value.lastStableFileFingerprint,
  };
}

// ---------------------------------------------------------------------------
// SessionEvent (reuses agent-domain's EventMetadata)
// ---------------------------------------------------------------------------

function toProtoSessionEvent(value: SessionEvent): ProtoSessionEvent {
  return create(SessionEventSchema, {
    eventId: value.eventId,
    hostId: value.hostId,
    sessionId: value.sessionId,
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    revision: value.revision,
    createdAtMs: value.createdAtMs,
    ...(value.causationCommandId === undefined
      ? {}
      : { causationCommandId: value.causationCommandId }),
    runtimeGeneration: value.runtimeGeneration,
    ...(value.ownershipEpoch === undefined ? {} : { ownershipEpoch: value.ownershipEpoch }),
    kind: value.kind,
    payload: value.payload,
  });
}

function fromProtoSessionEvent(value: ProtoSessionEvent): SessionEvent {
  if (value.sessionId === undefined) {
    throw new SessionProtocolError("MISSING_REQUIRED_FIELD", "SessionEvent is missing session_id");
  }
  if (value.runtimeGeneration === undefined) {
    throw new SessionProtocolError(
      "MISSING_REQUIRED_FIELD",
      "SessionEvent is missing runtime_generation",
    );
  }
  return {
    eventId: brandEventId(value.eventId),
    hostId: value.hostId,
    sessionId: brandSessionId(value.sessionId),
    ...(value.runId === undefined ? {} : { runId: brandRunId(value.runId) }),
    revision: value.revision,
    createdAtMs: value.createdAtMs,
    ...(value.causationCommandId === undefined
      ? {}
      : { causationCommandId: brandCommandId(value.causationCommandId) }),
    runtimeGeneration: value.runtimeGeneration,
    ...(value.ownershipEpoch === undefined ? {} : { ownershipEpoch: value.ownershipEpoch }),
    kind: value.kind,
    payload: value.payload,
  };
}

// ---------------------------------------------------------------------------
// TranscriptEvent (carried opaquely inside SessionEvent.payload; see the
// proto file's own doc comment for why this boundary is a versioned Protobuf
// message rather than the JSON Runtime<->Host use).
//
// `kind` mirrors packages/agent-domain's AgentDomainEvent discriminant
// exactly (e.g. "message-delta", "tool-started") rather than inventing a
// separate vocabulary, since SessionEvent.kind already carries that same
// string and Mobile filters/labels events by it (see
// apps/mobile/src/session-view.ts's describeSessionEventKind /
// reconstructTranscript). Three of the ten oneof cases each fan out to three
// AgentDomainEvent kinds apiece (tool_progress -> tool-started/-updated/
// -completed, subagent_progress -> subagent-started/-updated/-completed,
// agent_finished -> agent-ended/-failed/-interrupted) via a phase/outcome
// enum carried alongside; decodeTranscriptEvent is handed the outer
// SessionEvent.kind precisely so it can reject the (should-never-happen, but
// silently-corrupt-if-unchecked) case where that string and the payload's own
// phase/outcome enum disagree about which of the three actually happened.
// ---------------------------------------------------------------------------

export type TranscriptEventBody =
  | { readonly kind: "agent-started"; readonly runId: RunId }
  | { readonly kind: "message-started"; readonly messageId: string }
  | { readonly kind: "message-delta"; readonly messageId: string; readonly delta: string }
  | { readonly kind: "message-completed"; readonly messageId: string }
  | {
      readonly kind: "tool-started" | "tool-updated" | "tool-completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly displayJson?: string;
    }
  | {
      readonly kind: "approval-requested";
      readonly approvalRequestId: ApprovalRequestId;
      readonly expiresAtMs: bigint;
      readonly summary: string;
      readonly contentHash: Uint8Array;
    }
  | {
      readonly kind: "ui-requested";
      readonly uiRequestId: UiRequestId;
      readonly uiKind: "confirm" | "select" | "input" | "editor";
      readonly expiresAtMs: bigint;
      readonly payloadJson?: string;
      readonly contentHash: Uint8Array;
    }
  | {
      readonly kind: "subagent-started" | "subagent-updated" | "subagent-completed";
      readonly taskId: string;
      readonly displayJson?: string;
    }
  | { readonly kind: "todo-updated"; readonly items: readonly TodoItem[] }
  | {
      readonly kind: "agent-ended" | "agent-failed" | "agent-interrupted";
      readonly runId: RunId;
      readonly reason?: string;
    };

// Returned by decodeTranscriptEvent (never accepted by encodeTranscriptEvent,
// which only ever needs to encode a real event Host itself just observed)
// when the wire message's oneof case is not one this build's generated
// TranscriptEventSchema recognizes: a Host built against a newer proto than
// this Mobile build shipped with. This is exactly the forward-compatibility
// field-numbered oneofs exist to provide (see the proto file's doc comment),
// so it must never throw -- callers render nothing for it and move on.
export interface TranscriptEventUnknown {
  readonly kind: "unknown";
}

export type DecodedTranscriptEvent = TranscriptEventBody | TranscriptEventUnknown;

// TranscriptToolProgress.display_json / TranscriptUiRequested.payload_json
// carry an OMP SDK rendering/request structure that is `unknown` in
// packages/agent-domain (see the proto file's doc comment on why it is
// passed through as opaque JSON text rather than modeled as a typed field).
// That makes it the one part of a TranscriptEvent with no inherent size
// bound. Truncating it here keeps a single encoded TranscriptEvent
// comfortably under SECURE_PAYLOAD_MAX_BYTES (262_144) even after the
// surrounding SessionEvent fields, the SecurePayload envelope, and the AEAD
// seal's own overhead are added on top -- so one oversized rendering payload
// can never make the whole event fail encodeSecurePayload's size check and
// silently vanish from the transcript instead of just losing its richest
// detail. 64 KiB leaves generous headroom under the 256 KiB envelope budget
// for everything else in the message.
//
// Truncating the raw JSON string byte-for-byte (rather than dropping the
// field entirely, or re-serializing a shortened-but-still-valid JSON
// document) is deliberately the simplest option that satisfies the size
// budget: decoders already have to treat display_json/payload_json as
// opaque, best-effort, potentially-invalid JSON (Host never parses it either
// -- see the proto file's doc comment), so a truncated -- and therefore
// often syntactically invalid -- tail is exactly the same failure mode
// clients must already tolerate, just deliberately triggered under a size
// budget instead of left to chance.
const TRANSCRIPT_OPAQUE_JSON_MAX_BYTES = 65_536;

function truncateOpaqueJson(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= TRANSCRIPT_OPAQUE_JSON_MAX_BYTES) return value;
  return new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(0, TRANSCRIPT_OPAQUE_JSON_MAX_BYTES),
  );
}

export function encodeTranscriptEvent(body: TranscriptEventBody): Uint8Array {
  const proto = create(TranscriptEventSchema, { body: toProtoTranscriptEventBody(body) });
  return toBinary(TranscriptEventSchema, proto);
}

/**
 * Decodes a TranscriptEvent from SessionEvent.payload. `kind` is
 * SessionEvent.kind (the same granular AgentDomainEvent discriminant string
 * Host forwarded verbatim) and is used to validate that it agrees with the
 * phase/outcome enum carried inside the payload itself for the three
 * grouped oneof cases (tool_progress, subagent_progress, agent_finished);
 * a mismatch is rejected with SessionProtocolError("KIND_MISMATCH", ...)
 * rather than silently trusting either side. An unrecognized oneof case
 * (a Host built against a newer proto than this build) decodes to
 * `{ kind: "unknown" }` rather than throwing -- see DecodedTranscriptEvent.
 */
export function decodeTranscriptEvent(kind: string, payload: Uint8Array): DecodedTranscriptEvent {
  let proto: ProtoTranscriptEvent;
  try {
    proto = fromBinary(TranscriptEventSchema, payload);
  } catch (error) {
    throw new SessionProtocolError("MALFORMED_PAYLOAD", "Invalid TranscriptEvent protobuf", {
      cause: error,
    });
  }
  return fromProtoTranscriptEventBody(kind, proto.body);
}

function assertTranscriptKind(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SessionProtocolError(
      "KIND_MISMATCH",
      `SessionEvent.kind ${JSON.stringify(actual)} does not match the TranscriptEvent payload's own case (expected ${JSON.stringify(expected)})`,
    );
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed TranscriptEventBody union; a new case fails to compile.
function toProtoTranscriptEventBody(body: TranscriptEventBody): ProtoTranscriptEvent["body"] {
  switch (body.kind) {
    case "agent-started":
      return {
        case: "agentStarted",
        value: create(TranscriptAgentStartedSchema, { runId: body.runId }),
      };
    case "message-started":
      return {
        case: "messageStarted",
        value: create(TranscriptMessageStartedSchema, { messageId: body.messageId }),
      };
    case "message-delta":
      return {
        case: "messageDelta",
        value: create(TranscriptMessageDeltaSchema, {
          messageId: body.messageId,
          delta: body.delta,
        }),
      };
    case "message-completed":
      return {
        case: "messageCompleted",
        value: create(TranscriptMessageCompletedSchema, { messageId: body.messageId }),
      };
    case "tool-started":
    case "tool-updated":
    case "tool-completed":
      return {
        case: "toolProgress",
        value: create(TranscriptToolProgressSchema, {
          toolCallId: body.toolCallId,
          toolName: body.toolName,
          phase: toolPhaseToProto(body.kind),
          ...(body.displayJson === undefined
            ? {}
            : { displayJson: truncateOpaqueJson(body.displayJson) }),
        }),
      };
    case "approval-requested":
      return {
        case: "approvalRequested",
        value: create(TranscriptApprovalRequestedSchema, {
          approvalRequestId: body.approvalRequestId,
          expiresAtMs: body.expiresAtMs,
          summary: body.summary,
          contentHash: body.contentHash,
        }),
      };
    case "ui-requested":
      return {
        case: "uiRequested",
        value: create(TranscriptUiRequestedSchema, {
          uiRequestId: body.uiRequestId,
          uiKind: uiKindToProto(body.uiKind),
          expiresAtMs: body.expiresAtMs,
          ...(body.payloadJson === undefined
            ? {}
            : { payloadJson: truncateOpaqueJson(body.payloadJson) }),
          contentHash: body.contentHash,
        }),
      };
    case "subagent-started":
    case "subagent-updated":
    case "subagent-completed":
      return {
        case: "subagentProgress",
        value: create(TranscriptSubagentProgressSchema, {
          taskId: body.taskId,
          phase: subagentPhaseToProto(body.kind),
          ...(body.displayJson === undefined
            ? {}
            : { displayJson: truncateOpaqueJson(body.displayJson) }),
        }),
      };
    case "todo-updated":
      return {
        case: "todoUpdated",
        value: create(TranscriptTodoUpdatedSchema, {
          items: body.items.map(toProtoTranscriptTodoItem),
        }),
      };
    case "agent-ended":
    case "agent-failed":
    case "agent-interrupted":
      return {
        case: "agentFinished",
        value: create(TranscriptAgentFinishedSchema, {
          runId: body.runId,
          outcome: agentOutcomeToProto(body.kind),
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }),
      };
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the generated oneof case union; `undefined` is the forward-compatible fallback (see DecodedTranscriptEvent).
function fromProtoTranscriptEventBody(
  kind: string,
  body: ProtoTranscriptEvent["body"],
): DecodedTranscriptEvent {
  switch (body.case) {
    case "agentStarted":
      assertTranscriptKind(kind, "agent-started");
      return { kind: "agent-started", runId: brandRunId(body.value.runId) };
    case "messageStarted":
      assertTranscriptKind(kind, "message-started");
      return { kind: "message-started", messageId: body.value.messageId };
    case "messageDelta":
      assertTranscriptKind(kind, "message-delta");
      return {
        kind: "message-delta",
        messageId: body.value.messageId,
        delta: body.value.delta,
      };
    case "messageCompleted":
      assertTranscriptKind(kind, "message-completed");
      return { kind: "message-completed", messageId: body.value.messageId };
    case "toolProgress": {
      const toolKind = toolPhaseFromProto(body.value.phase);
      assertTranscriptKind(kind, toolKind);
      return {
        kind: toolKind,
        toolCallId: body.value.toolCallId,
        toolName: body.value.toolName,
        ...(body.value.displayJson === undefined ? {} : { displayJson: body.value.displayJson }),
      };
    }
    case "approvalRequested":
      assertTranscriptKind(kind, "approval-requested");
      return {
        kind: "approval-requested",
        approvalRequestId: brandApprovalRequestId(body.value.approvalRequestId),
        expiresAtMs: body.value.expiresAtMs,
        summary: body.value.summary,
        contentHash: body.value.contentHash,
      };
    case "uiRequested":
      assertTranscriptKind(kind, "ui-requested");
      return {
        kind: "ui-requested",
        uiRequestId: brandUiRequestId(body.value.uiRequestId),
        uiKind: uiKindFromProto(body.value.uiKind),
        expiresAtMs: body.value.expiresAtMs,
        ...(body.value.payloadJson === undefined ? {} : { payloadJson: body.value.payloadJson }),
        contentHash: body.value.contentHash,
      };
    case "subagentProgress": {
      const subagentKind = subagentPhaseFromProto(body.value.phase);
      assertTranscriptKind(kind, subagentKind);
      return {
        kind: subagentKind,
        taskId: body.value.taskId,
        ...(body.value.displayJson === undefined ? {} : { displayJson: body.value.displayJson }),
      };
    }
    case "todoUpdated":
      assertTranscriptKind(kind, "todo-updated");
      return {
        kind: "todo-updated",
        items: body.value.items.map(fromProtoTranscriptTodoItem),
      };
    case "agentFinished": {
      const outcomeKind = agentOutcomeFromProto(body.value.outcome);
      assertTranscriptKind(kind, outcomeKind);
      return {
        kind: outcomeKind,
        runId: brandRunId(body.value.runId),
        ...(body.value.reason === undefined ? {} : { reason: body.value.reason }),
      };
    }
    case undefined:
      return { kind: "unknown" };
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new tool kind fails to compile.
function toolPhaseToProto(
  kind: "tool-started" | "tool-updated" | "tool-completed",
): TranscriptToolPhase {
  switch (kind) {
    case "tool-started":
      return TranscriptToolPhase.STARTED;
    case "tool-updated":
      return TranscriptToolPhase.UPDATED;
    case "tool-completed":
      return TranscriptToolPhase.COMPLETED;
  }
}

function toolPhaseFromProto(
  phase: TranscriptToolPhase,
): "tool-started" | "tool-updated" | "tool-completed" {
  switch (phase) {
    case TranscriptToolPhase.STARTED:
      return "tool-started";
    case TranscriptToolPhase.UPDATED:
      return "tool-updated";
    case TranscriptToolPhase.COMPLETED:
      return "tool-completed";
    default:
      throw new SessionProtocolError(
        "MALFORMED_PAYLOAD",
        `TranscriptToolProgress has an unsupported phase ${String(phase)}`,
      );
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new subagent kind fails to compile.
function subagentPhaseToProto(
  kind: "subagent-started" | "subagent-updated" | "subagent-completed",
): TranscriptSubagentPhase {
  switch (kind) {
    case "subagent-started":
      return TranscriptSubagentPhase.STARTED;
    case "subagent-updated":
      return TranscriptSubagentPhase.UPDATED;
    case "subagent-completed":
      return TranscriptSubagentPhase.COMPLETED;
  }
}

function subagentPhaseFromProto(
  phase: TranscriptSubagentPhase,
): "subagent-started" | "subagent-updated" | "subagent-completed" {
  switch (phase) {
    case TranscriptSubagentPhase.STARTED:
      return "subagent-started";
    case TranscriptSubagentPhase.UPDATED:
      return "subagent-updated";
    case TranscriptSubagentPhase.COMPLETED:
      return "subagent-completed";
    default:
      throw new SessionProtocolError(
        "MALFORMED_PAYLOAD",
        `TranscriptSubagentProgress has an unsupported phase ${String(phase)}`,
      );
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new outcome kind fails to compile.
function agentOutcomeToProto(
  kind: "agent-ended" | "agent-failed" | "agent-interrupted",
): TranscriptAgentOutcome {
  switch (kind) {
    case "agent-ended":
      return TranscriptAgentOutcome.ENDED;
    case "agent-failed":
      return TranscriptAgentOutcome.FAILED;
    case "agent-interrupted":
      return TranscriptAgentOutcome.INTERRUPTED;
  }
}

function agentOutcomeFromProto(
  outcome: TranscriptAgentOutcome,
): "agent-ended" | "agent-failed" | "agent-interrupted" {
  switch (outcome) {
    case TranscriptAgentOutcome.ENDED:
      return "agent-ended";
    case TranscriptAgentOutcome.FAILED:
      return "agent-failed";
    case TranscriptAgentOutcome.INTERRUPTED:
      return "agent-interrupted";
    default:
      throw new SessionProtocolError(
        "MALFORMED_PAYLOAD",
        `TranscriptAgentFinished has an unsupported outcome ${String(outcome)}`,
      );
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new ui kind fails to compile.
function uiKindToProto(kind: "confirm" | "select" | "input" | "editor"): TranscriptUiKind {
  switch (kind) {
    case "confirm":
      return TranscriptUiKind.CONFIRM;
    case "select":
      return TranscriptUiKind.SELECT;
    case "input":
      return TranscriptUiKind.INPUT;
    case "editor":
      return TranscriptUiKind.EDITOR;
  }
}

function uiKindFromProto(kind: TranscriptUiKind): "confirm" | "select" | "input" | "editor" {
  switch (kind) {
    case TranscriptUiKind.CONFIRM:
      return "confirm";
    case TranscriptUiKind.SELECT:
      return "select";
    case TranscriptUiKind.INPUT:
      return "input";
    case TranscriptUiKind.EDITOR:
      return "editor";
    default:
      throw new SessionProtocolError(
        "MALFORMED_PAYLOAD",
        `TranscriptUiRequested has an unsupported ui_kind ${String(kind)}`,
      );
  }
}

function toProtoTranscriptTodoItem(item: TodoItem): ProtoTranscriptTodoItem {
  return create(TranscriptTodoItemSchema, {
    id: item.id,
    text: item.text,
    status: todoStatusToProto(item.status),
  });
}

function fromProtoTranscriptTodoItem(item: ProtoTranscriptTodoItem): TodoItem {
  return {
    id: item.id,
    text: item.text,
    status: todoStatusFromProto(item.status),
  };
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over TodoItem["status"]'s closed literal union; a new status fails to compile.
function todoStatusToProto(status: TodoItem["status"]): TranscriptTodoStatus {
  switch (status) {
    case "pending":
      return TranscriptTodoStatus.PENDING;
    case "in-progress":
      return TranscriptTodoStatus.IN_PROGRESS;
    case "completed":
      return TranscriptTodoStatus.COMPLETED;
    case "cancelled":
      return TranscriptTodoStatus.CANCELLED;
  }
}

function todoStatusFromProto(status: TranscriptTodoStatus): TodoItem["status"] {
  switch (status) {
    case TranscriptTodoStatus.PENDING:
      return "pending";
    case TranscriptTodoStatus.IN_PROGRESS:
      return "in-progress";
    case TranscriptTodoStatus.COMPLETED:
      return "completed";
    case TranscriptTodoStatus.CANCELLED:
      return "cancelled";
    default:
      throw new SessionProtocolError(
        "MALFORMED_PAYLOAD",
        `TranscriptTodoItem has an unsupported status ${String(status)}`,
      );
  }
}

// ---------------------------------------------------------------------------
// ClientCommand
// ---------------------------------------------------------------------------

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed ClientCommandCase union; a new case fails to compile.
function toProtoClientCommandCase(body: ClientCommandCase): ProtoClientCommand["command"] {
  switch (body.kind) {
    case "start-session":
      return {
        case: "startSession",
        value: create(StartSessionSchema, { workspaceId: body.workspaceId }),
      };
    case "resume-session":
      return {
        case: "resumeSession",
        value: create(ResumeSessionSchema, { sessionId: body.sessionId }),
      };
    case "submit-prompt":
      return {
        case: "submitPrompt",
        value: create(SubmitPromptSchema, {
          text: body.text,
          attachmentIds: [...body.attachmentIds],
        }),
      };
    case "steer-agent":
      return { case: "steerAgent", value: create(SteerAgentSchema, { text: body.text }) };
    case "queue-follow-up":
      return {
        case: "queueFollowUp",
        value: create(QueueFollowUpSchema, { text: body.text }),
      };
    case "abort-agent":
      return { case: "abortAgent", value: create(AbortAgentSchema, {}) };
    case "respond-to-approval":
      return {
        case: "respondToApproval",
        value: create(RespondToApprovalSchema, {
          approvalRequestId: body.approvalRequestId,
          allow: body.allow,
          displayedContentHash: body.displayedContentHash,
        }),
      };
    case "respond-to-ui":
      return {
        case: "respondToUi",
        value: create(RespondToUiSchema, {
          uiRequestId: body.uiRequestId,
          response: body.response,
          displayedContentHash: body.displayedContentHash,
        }),
      };
    case "set-model":
      return {
        case: "setModel",
        value: create(SetModelSchema, { provider: body.provider, modelId: body.modelId }),
      };
    case "set-thinking-level":
      return {
        case: "setThinkingLevel",
        value: create(SetThinkingLevelSchema, { level: body.level }),
      };
    case "compact-session":
      return { case: "compactSession", value: create(CompactSessionSchema, {}) };
    case "list-files":
      return {
        case: "listFiles",
        value: create(ListFilesSchema, { relativePath: body.relativePath }),
      };
    case "read-file":
      return {
        case: "readFile",
        value: create(ReadFileSchema, {
          relativePath: body.relativePath,
          offset: body.offset,
          limit: body.limit,
        }),
      };
    case "get-git-diff":
      return { case: "getGitDiff", value: create(GetGitDiffSchema, { staged: body.staged }) };
    case "execute-git-action":
      return {
        case: "executeGitAction",
        value: create(ExecuteGitActionSchema, {
          action: body.action,
          arguments: [...body.arguments],
          displayedContentHash: body.displayedContentHash,
        }),
      };
    case "list-sessions":
      return { case: "listSessions", value: create(ListSessionsSchema, {}) };
    case "search-sessions":
      return {
        case: "searchSessions",
        value: create(SearchSessionsSchema, { query: body.query }),
      };
    case "fork-session":
      return {
        case: "forkSession",
        value: create(ForkSessionSchema, { sourceSessionId: body.sourceSessionId }),
      };
    case "archive-session":
      return {
        case: "archiveSession",
        value: create(ArchiveSessionSchema, { sessionId: body.sessionId }),
      };
    case "refresh-session-catalog":
      return {
        case: "refreshSessionCatalog",
        value: create(RefreshSessionCatalogSchema, {}),
      };
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the generated oneof case union (including "undefined", which throws).
function fromProtoClientCommandCase(command: ProtoClientCommand["command"]): ClientCommandCase {
  switch (command.case) {
    case "startSession":
      return { kind: "start-session", workspaceId: command.value.workspaceId };
    case "resumeSession":
      return { kind: "resume-session", sessionId: brandSessionId(command.value.sessionId) };
    case "submitPrompt":
      return {
        kind: "submit-prompt",
        text: command.value.text,
        attachmentIds: [...command.value.attachmentIds],
      };
    case "steerAgent":
      return { kind: "steer-agent", text: command.value.text };
    case "queueFollowUp":
      return { kind: "queue-follow-up", text: command.value.text };
    case "abortAgent":
      return { kind: "abort-agent" };
    case "respondToApproval":
      return {
        kind: "respond-to-approval",
        approvalRequestId: brandApprovalRequestId(command.value.approvalRequestId),
        allow: command.value.allow,
        displayedContentHash: command.value.displayedContentHash,
      };
    case "respondToUi":
      return {
        kind: "respond-to-ui",
        uiRequestId: brandUiRequestId(command.value.uiRequestId),
        response: command.value.response,
        displayedContentHash: command.value.displayedContentHash,
      };
    case "setModel":
      return {
        kind: "set-model",
        provider: command.value.provider,
        modelId: command.value.modelId,
      };
    case "setThinkingLevel":
      return { kind: "set-thinking-level", level: command.value.level };
    case "compactSession":
      return { kind: "compact-session" };
    case "listFiles":
      return { kind: "list-files", relativePath: command.value.relativePath };
    case "readFile":
      return {
        kind: "read-file",
        relativePath: command.value.relativePath,
        offset: command.value.offset,
        limit: command.value.limit,
      };
    case "getGitDiff":
      return { kind: "get-git-diff", staged: command.value.staged };
    case "executeGitAction":
      return {
        kind: "execute-git-action",
        action: command.value.action,
        arguments: [...command.value.arguments],
        displayedContentHash: command.value.displayedContentHash,
      };
    case "listSessions":
      return { kind: "list-sessions" };
    case "searchSessions":
      return { kind: "search-sessions", query: command.value.query };
    case "forkSession":
      return {
        kind: "fork-session",
        sourceSessionId: brandSessionId(command.value.sourceSessionId),
      };
    case "archiveSession":
      return { kind: "archive-session", sessionId: brandSessionId(command.value.sessionId) };
    case "refreshSessionCatalog":
      return { kind: "refresh-session-catalog" };
    case undefined:
      throw new SessionProtocolError("EMPTY_BODY", "ClientCommand is missing a command");
  }
}

function toProtoClientCommand(value: ClientCommand): ProtoClientCommand {
  return create(ClientCommandSchema, {
    commandId: value.commandId,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    command: toProtoClientCommandCase(value.command),
  });
}

function fromProtoClientCommand(value: ProtoClientCommand): ClientCommand {
  return {
    commandId: brandCommandId(value.commandId),
    ...(value.sessionId === undefined ? {} : { sessionId: brandSessionId(value.sessionId) }),
    issuedAtMs: value.issuedAtMs,
    expiresAtMs: value.expiresAtMs,
    command: fromProtoClientCommandCase(value.command),
  };
}

// ---------------------------------------------------------------------------
// CommandAccepted / CommandResult
// ---------------------------------------------------------------------------

function toProtoCommandAccepted(value: CommandAccepted): ProtoCommandAccepted {
  return create(CommandAcceptedSchema, {
    commandId: value.commandId,
    runtimeId: value.runtimeId,
    runtimeGeneration: value.runtimeGeneration,
  });
}

function fromProtoCommandAccepted(value: ProtoCommandAccepted): CommandAccepted {
  return {
    commandId: brandCommandId(value.commandId),
    runtimeId: value.runtimeId,
    runtimeGeneration: value.runtimeGeneration,
  };
}

function toProtoCommandResult(value: CommandResult): ProtoCommandResult {
  return create(CommandResultSchema, {
    commandId: value.commandId,
    success: value.success,
    code: value.code,
    message: value.message,
  });
}

function fromProtoCommandResult(value: ProtoCommandResult): CommandResult {
  return {
    commandId: brandCommandId(value.commandId),
    success: value.success,
    code: value.code,
    message: value.message,
  };
}

// ---------------------------------------------------------------------------
// ApprovalRequest / ApprovalResponse
// ---------------------------------------------------------------------------

function toProtoApprovalRequest(value: ApprovalRequest): ProtoApprovalRequest {
  return create(ApprovalRequestSchema, {
    approvalRequestId: value.approvalRequestId,
    sessionId: value.sessionId,
    runtimeGeneration: value.runtimeGeneration,
    expiresAtMs: value.expiresAtMs,
    kind: value.kind,
    summary: value.summary,
    contentHash: value.contentHash,
  });
}

function fromProtoApprovalRequest(value: ProtoApprovalRequest): ApprovalRequest {
  return {
    approvalRequestId: brandApprovalRequestId(value.approvalRequestId),
    sessionId: brandSessionId(value.sessionId),
    runtimeGeneration: value.runtimeGeneration,
    expiresAtMs: value.expiresAtMs,
    kind: value.kind,
    summary: value.summary,
    contentHash: value.contentHash,
  };
}

function toProtoApprovalResponse(value: ApprovalResponse): ProtoApprovalResponse {
  return create(ApprovalResponseSchema, {
    approvalRequestId: value.approvalRequestId,
    allow: value.allow,
    contentHash: value.contentHash,
  });
}

function fromProtoApprovalResponse(value: ProtoApprovalResponse): ApprovalResponse {
  return {
    approvalRequestId: brandApprovalRequestId(value.approvalRequestId),
    allow: value.allow,
    contentHash: value.contentHash,
  };
}

// ---------------------------------------------------------------------------
// UiRequest / UiResponse
// ---------------------------------------------------------------------------

function toProtoUiRequest(value: UiRequest): ProtoUiRequest {
  return create(UiRequestSchema, {
    uiRequestId: value.uiRequestId,
    sessionId: value.sessionId,
    runtimeGeneration: value.runtimeGeneration,
    expiresAtMs: value.expiresAtMs,
    kind: value.kind,
    payload: value.payload,
    contentHash: value.contentHash,
  });
}

function fromProtoUiRequest(value: ProtoUiRequest): UiRequest {
  return {
    uiRequestId: brandUiRequestId(value.uiRequestId),
    sessionId: brandSessionId(value.sessionId),
    runtimeGeneration: value.runtimeGeneration,
    expiresAtMs: value.expiresAtMs,
    kind: value.kind,
    payload: value.payload,
    contentHash: value.contentHash,
  };
}

function toProtoUiResponse(value: UiResponse): ProtoUiResponse {
  return create(UiResponseSchema, {
    uiRequestId: value.uiRequestId,
    payload: value.payload,
    contentHash: value.contentHash,
  });
}

function fromProtoUiResponse(value: ProtoUiResponse): UiResponse {
  return {
    uiRequestId: brandUiRequestId(value.uiRequestId),
    payload: value.payload,
    contentHash: value.contentHash,
  };
}

// ---------------------------------------------------------------------------
// AttachmentManifest / AttachmentChunk
// ---------------------------------------------------------------------------

function toProtoAttachmentChunk(value: AttachmentChunk): ProtoAttachmentChunk {
  return create(AttachmentChunkSchema, {
    index: value.index,
    nonce: value.nonce,
    ciphertextHash: value.ciphertextHash,
    ciphertextSize: value.ciphertextSize,
  });
}

function fromProtoAttachmentChunk(value: ProtoAttachmentChunk): AttachmentChunk {
  return {
    index: value.index,
    nonce: value.nonce,
    ciphertextHash: value.ciphertextHash,
    ciphertextSize: value.ciphertextSize,
  };
}

function toProtoAttachmentManifest(value: AttachmentManifest): ProtoAttachmentManifest {
  return create(AttachmentManifestSchema, {
    objectId: value.objectId,
    contentKey: value.contentKey,
    plaintextHash: value.plaintextHash,
    ciphertextHash: value.ciphertextHash,
    size: value.size,
    mime: value.mime,
    fileName: value.fileName,
    chunks: value.chunks.map(toProtoAttachmentChunk),
    expiresAtMs: value.expiresAtMs,
  });
}

function fromProtoAttachmentManifest(value: ProtoAttachmentManifest): AttachmentManifest {
  return {
    objectId: value.objectId,
    contentKey: value.contentKey,
    plaintextHash: value.plaintextHash,
    ciphertextHash: value.ciphertextHash,
    size: value.size,
    mime: value.mime,
    fileName: value.fileName,
    chunks: value.chunks.map(fromProtoAttachmentChunk),
    expiresAtMs: value.expiresAtMs,
  };
}

// ---------------------------------------------------------------------------
// SecureError
// ---------------------------------------------------------------------------

function toProtoSecureError(value: SecureError): ProtoSecureError {
  return create(SecureErrorSchema, {
    code: value.code,
    message: value.message,
    retryable: value.retryable,
  });
}

function fromProtoSecureError(value: ProtoSecureError): SecureError {
  return {
    code: value.code,
    message: value.message,
    retryable: value.retryable,
  };
}

// ---------------------------------------------------------------------------
// Envelope seal/open (ADR-005)
//
// Host and Mobile are implemented independently and in parallel; if each side
// assembled the AEAD's AAD on its own, one field ordered differently would
// make every open() fail with AUTHENTICATION_FAILED with no useful signal as
// to why. sealEnvelope/openEnvelope (and the sealSecurePayload/openSecurePayload
// convenience wrappers built on top of them below) are therefore the only
// supported way to produce or consume relay envelopes: all of them funnel
// through the private toCryptoEnvelopeMetadata helper below, which is the
// single place implementing the EnvelopeMetadata <-> proto envelope field
// mapping.
//
// Unlike the SecurePayload domain types above (ADR-008), the sealed envelope
// itself *is* the wire format defined by relay.proto, so these functions
// return/accept the generated OutboundEnvelope/SealedEnvelope/DeliveredEnvelope
// types directly rather than introducing a parallel domain shape for them.
//
// sealEnvelope/openEnvelope operate on raw plaintext bytes rather than a
// SecurePayloadBody. Host-side adapters implementing the host-core
// HostEnvelopeCrypto contract (seal(recipientDeviceId, plaintext: Uint8Array))
// need exactly this bytes-level shape, since that interface's plaintext is
// already opaque bytes rather than a decoded SecurePayloadBody.
// sealSecurePayload/openSecurePayload remain the right choice whenever a
// SecurePayloadBody is available, and are implemented purely in terms of
// sealEnvelope/openEnvelope plus the SecurePayload codec above.
// ---------------------------------------------------------------------------

export interface SecureEnvelopeMetadata {
  readonly messageId: string;
  readonly routeId: string;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  readonly clientSequence: bigint;
  readonly createdAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly keyId: string;
  readonly priority: Priority;
  readonly notificationHint: NotificationHint;
}

export function sealEnvelope(
  pairwiseKey: Uint8Array,
  metadata: SecureEnvelopeMetadata,
  plaintext: Uint8Array,
  random: RandomSource,
): ProtoOutboundEnvelope {
  validatePairwiseKey(pairwiseKey);
  validateSecureEnvelopeMetadata(metadata);
  const sealed = cryptoSeal(pairwiseKey, toCryptoEnvelopeMetadata(metadata), plaintext, random);
  return create(OutboundEnvelopeSchema, {
    messageId: metadata.messageId,
    routeId: metadata.routeId,
    senderDeviceId: metadata.senderDeviceId,
    recipientDeviceId: metadata.recipientDeviceId,
    clientSequence: metadata.clientSequence,
    createdAtMs: metadata.createdAtMs,
    expiresAtMs: metadata.expiresAtMs,
    keyId: metadata.keyId,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    priority: metadata.priority,
    notificationHint: metadata.notificationHint,
  });
}

export function openEnvelope(
  pairwiseKey: Uint8Array,
  envelope: ProtoSealedEnvelope | ProtoDeliveredEnvelope,
): Uint8Array {
  validatePairwiseKey(pairwiseKey);
  const sealedEnvelope = toSealedEnvelope(envelope);
  validateSecureEnvelopeMetadata(sealedEnvelope);
  return cryptoOpen(pairwiseKey, toCryptoEnvelopeMetadata(sealedEnvelope), {
    nonce: sealedEnvelope.nonce,
    ciphertext: sealedEnvelope.ciphertext,
  });
}

export function sealSecurePayload(
  pairwiseKey: Uint8Array,
  metadata: SecureEnvelopeMetadata,
  body: SecurePayloadBody,
  random: RandomSource,
): ProtoOutboundEnvelope {
  return sealEnvelope(pairwiseKey, metadata, encodeSecurePayload(body), random);
}

export function openSecurePayload(
  pairwiseKey: Uint8Array,
  envelope: ProtoSealedEnvelope | ProtoDeliveredEnvelope,
): SecurePayloadBody {
  return decodeSecurePayload(openEnvelope(pairwiseKey, envelope));
}

function toSealedEnvelope(
  envelope: ProtoSealedEnvelope | ProtoDeliveredEnvelope,
): ProtoSealedEnvelope {
  if (envelope.$typeName === "pocket.omp.relay.v1.SealedEnvelope") {
    return envelope;
  }
  if (envelope.envelope === undefined) {
    throw new SessionProtocolError(
      "MISSING_REQUIRED_FIELD",
      "DeliveredEnvelope is missing its sealed envelope",
    );
  }
  return envelope.envelope;
}

// The one place that implements the EnvelopeMetadata <-> proto envelope field
// mapping (see the seal/open contract table in ADR-005). Both
// sealSecurePayload and openSecurePayload call this helper so Host and Mobile
// can never diverge on how the AAD is assembled; it is intentionally not
// exported.
function toCryptoEnvelopeMetadata(metadata: SecureEnvelopeMetadata): CryptoEnvelopeMetadata {
  return {
    protocolVersion: E2EE_PROTOCOL_VERSION,
    messageId: metadata.messageId,
    routeId: metadata.routeId,
    senderDeviceId: metadata.senderDeviceId,
    recipientDeviceId: metadata.recipientDeviceId,
    clientSequence: metadata.clientSequence,
    createdAtMs: metadata.createdAtMs,
    expiresAtMs: metadata.expiresAtMs,
    keyId: metadata.keyId,
    priority: metadata.priority,
    notificationHint: metadata.notificationHint,
  };
}

function validatePairwiseKey(key: Uint8Array): void {
  if (key.byteLength !== AEAD_KEY_BYTES) {
    throw new SessionProtocolError(
      "INVALID_KEY_LENGTH",
      `Pairwise key must be ${AEAD_KEY_BYTES} bytes, got ${key.byteLength}`,
    );
  }
}

function validateSecureEnvelopeMetadata(metadata: SecureEnvelopeMetadata): void {
  for (const [value, field] of [
    [metadata.messageId, "message_id"],
    [metadata.routeId, "route_id"],
    [metadata.senderDeviceId, "sender_device_id"],
    [metadata.recipientDeviceId, "recipient_device_id"],
    [metadata.keyId, "key_id"],
  ] as const) {
    if (value.length === 0) {
      throw new SessionProtocolError(
        "MISSING_REQUIRED_FIELD",
        `Envelope metadata is missing ${field}`,
      );
    }
  }
}

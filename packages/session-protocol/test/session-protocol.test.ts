import { create, toBinary } from "@bufbuild/protobuf";
import {
  approvalRequestId,
  commandId,
  eventId,
  runId,
  sessionId,
  uiRequestId,
} from "@pocket-omp/agent-domain";
import { AEAD_KEY_BYTES, CryptoContractError, type RandomSource } from "@pocket-omp/crypto";
import {
  DeliveredEnvelopeSchema,
  NotificationHint,
  type OutboundEnvelope,
  Priority,
  type SealedEnvelope,
  SealedEnvelopeSchema,
} from "@pocket-omp/proto/relay/v1";
import {
  ClientCommandSchema,
  SecurePayloadSchema,
  SessionEventSchema,
} from "@pocket-omp/proto/session/v1";
import { expect, test } from "bun:test";
import {
  decodeSecurePayload,
  encodeSecurePayload,
  openEnvelope,
  openSecurePayload,
  sealEnvelope,
  sealSecurePayload,
  SECURE_PAYLOAD_MAX_BYTES,
  SESSION_PROTOCOL_VERSION,
  SessionProtocolError,
  type ClientCommandCase,
  type SecureEnvelopeMetadata,
  type SecurePayloadBody,
  type SecurePayloadCase,
} from "../src/index";

const UINT64_MAX = 2n ** 64n - 1n;
const INT64_MAX = 2n ** 63n - 1n;

function roundTrip(body: SecurePayloadCase, capabilitySet = "cap-a,cap-b"): SecurePayloadBody {
  const input: SecurePayloadBody = { capabilitySet, body };
  const bytes = encodeSecurePayload(input);
  const decoded = decodeSecurePayload(bytes);
  expect(decoded).toEqual(input);
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

test("round-trips capability_set and protocol_version through the wire", () => {
  const decoded = roundTrip({
    kind: "device-hello",
    value: { deviceId: "device-1", deviceKind: "mobile", capabilities: ["push", "biometric"] },
  });
  expect(decoded.capabilitySet).toBe("cap-a,cap-b");
});

test("round-trips device-hello", () => {
  roundTrip({
    kind: "device-hello",
    value: { deviceId: "device-1", deviceKind: "mobile", capabilities: [] },
  });
});

test("round-trips host-snapshot with nested session summaries", () => {
  roundTrip({
    kind: "host-snapshot",
    value: {
      hostId: "host-1",
      displayName: "My Mac",
      sessions: [
        {
          sessionId: sessionId("session-1"),
          title: "Fix bug",
          cwdDisplayName: "~/apps/pocket-omp",
          updatedAtMs: 1_700_000_000_000n,
          compatibility: "fully-compatible",
          ownership: "pocket-owned",
        },
        {
          sessionId: sessionId("session-2"),
          title: "Refactor",
          cwdDisplayName: "~/apps/other",
          updatedAtMs: 0n,
          compatibility: "unsupported",
          ownership: "idle",
        },
      ],
    },
  });
});

test("round-trips host-snapshot with no sessions", () => {
  roundTrip({
    kind: "host-snapshot",
    value: { hostId: "host-1", displayName: "Empty host", sessions: [] },
  });
});

test("round-trips session-snapshot with the optional session_format_version present", () => {
  roundTrip({
    kind: "session-snapshot",
    value: {
      sessionId: sessionId("session-1"),
      revision: UINT64_MAX,
      stateHash: "hash",
      baseEventSequence: 42n,
      projection: new Uint8Array([1, 2, 3]),
      sessionFileId: "file-1",
      canonicalPathHash: "path-hash",
      recordedCwd: "/workspace",
      ownershipState: "pocket-owned",
      ownershipEpoch: 7n,
      compatibilityState: "fully-compatible",
      sdkVersion: "1.0.0",
      tuiVersion: "1.0.0",
      sessionFormatVersion: "2",
      runtimeGeneration: 3n,
      activeRunState: "idle",
      pendingInteractionCount: 0,
      lastStableFileFingerprint: "fingerprint",
    },
  });
});

test("round-trips session-snapshot with the optional session_format_version absent", () => {
  const decoded = roundTrip({
    kind: "session-snapshot",
    value: {
      sessionId: sessionId("session-1"),
      revision: 1n,
      stateHash: "hash",
      baseEventSequence: 0n,
      projection: new Uint8Array(),
      sessionFileId: "file-1",
      canonicalPathHash: "path-hash",
      recordedCwd: "/workspace",
      ownershipState: "idle",
      ownershipEpoch: 0n,
      compatibilityState: "fully-compatible",
      sdkVersion: "1.0.0",
      tuiVersion: "1.0.0",
      runtimeGeneration: 0n,
      activeRunState: "idle",
      pendingInteractionCount: 3,
      lastStableFileFingerprint: "fingerprint",
    },
  });
  if (decoded.body.kind !== "session-snapshot") throw new Error("expected session-snapshot");
  expect(decoded.body.value.sessionFormatVersion).toBeUndefined();
});

test("round-trips session-event with all optional fields present", () => {
  roundTrip({
    kind: "session-event",
    value: {
      eventId: eventId("event-1"),
      hostId: "host-1",
      sessionId: sessionId("session-1"),
      runId: runId("run-1"),
      revision: INT64_MAX,
      createdAtMs: 1_700_000_000_000n,
      causationCommandId: commandId("command-1"),
      runtimeGeneration: UINT64_MAX,
      ownershipEpoch: 5n,
      kind: "agent-started",
      payload: new Uint8Array([9, 9, 9]),
    },
  });
});

test("round-trips session-event with optional fields absent", () => {
  const decoded = roundTrip({
    kind: "session-event",
    value: {
      eventId: eventId("event-1"),
      hostId: "host-1",
      sessionId: sessionId("session-1"),
      revision: 1n,
      createdAtMs: 0n,
      runtimeGeneration: 0n,
      kind: "message-started",
      payload: new Uint8Array(),
    },
  });
  if (decoded.body.kind !== "session-event") throw new Error("expected session-event");
  expect(decoded.body.value.runId).toBeUndefined();
  expect(decoded.body.value.causationCommandId).toBeUndefined();
  expect(decoded.body.value.ownershipEpoch).toBeUndefined();
});

test("round-trips command-accepted", () => {
  roundTrip({
    kind: "command-accepted",
    value: { commandId: commandId("command-1"), runtimeId: "runtime-1", runtimeGeneration: 4n },
  });
});

test("round-trips command-result", () => {
  roundTrip({
    kind: "command-result",
    value: {
      commandId: commandId("command-1"),
      success: false,
      code: "INVALID_STATE",
      message: "cannot submit while running",
    },
  });
});

test("round-trips approval-request and approval-response", () => {
  roundTrip({
    kind: "approval-request",
    value: {
      approvalRequestId: approvalRequestId("approval-1"),
      sessionId: sessionId("session-1"),
      runtimeGeneration: 1n,
      expiresAtMs: 1_700_000_100_000n,
      kind: "bash",
      summary: "run rm -rf",
      contentHash: new Uint8Array(32).fill(0xab),
    },
  });
  roundTrip({
    kind: "approval-response",
    value: {
      approvalRequestId: approvalRequestId("approval-1"),
      allow: true,
      contentHash: new Uint8Array(32).fill(0xab),
    },
  });
});

test("round-trips ui-request and ui-response", () => {
  roundTrip({
    kind: "ui-request",
    value: {
      uiRequestId: uiRequestId("ui-1"),
      sessionId: sessionId("session-1"),
      runtimeGeneration: 1n,
      expiresAtMs: 1_700_000_100_000n,
      kind: "select",
      payload: new Uint8Array([1, 2]),
      contentHash: new Uint8Array(32).fill(0xcd),
    },
  });
  roundTrip({
    kind: "ui-response",
    value: {
      uiRequestId: uiRequestId("ui-1"),
      payload: new Uint8Array([3, 4]),
      contentHash: new Uint8Array(32).fill(0xcd),
    },
  });
});

test("round-trips attachment-manifest with chunks", () => {
  roundTrip({
    kind: "attachment-manifest",
    value: {
      objectId: "object-1",
      contentKey: new Uint8Array(32).fill(1),
      plaintextHash: new Uint8Array(32).fill(2),
      ciphertextHash: new Uint8Array(32).fill(3),
      size: 1_048_576n,
      mime: "image/png",
      fileName: "screenshot.png",
      chunks: [
        {
          index: 0,
          nonce: new Uint8Array(24).fill(4),
          ciphertextHash: new Uint8Array(32).fill(5),
          ciphertextSize: 65_536n,
        },
        {
          index: 1,
          nonce: new Uint8Array(24).fill(6),
          ciphertextHash: new Uint8Array(32).fill(7),
          ciphertextSize: 65_536n,
        },
      ],
      expiresAtMs: 1_700_000_200_000n,
    },
  });
});

test("round-trips attachment-manifest with no chunks", () => {
  roundTrip({
    kind: "attachment-manifest",
    value: {
      objectId: "object-1",
      contentKey: new Uint8Array(),
      plaintextHash: new Uint8Array(),
      ciphertextHash: new Uint8Array(),
      size: 0n,
      mime: "text/plain",
      fileName: "",
      chunks: [],
      expiresAtMs: 0n,
    },
  });
});

test("round-trips error", () => {
  roundTrip({
    kind: "error",
    value: { code: "SESSION_NOT_FOUND", message: "no such session", retryable: true },
  });
});

const clientCommandCases: readonly ClientCommandCase[] = [
  { kind: "start-session", workspaceId: "workspace-1" },
  { kind: "resume-session", sessionId: sessionId("session-1") },
  { kind: "submit-prompt", text: "hello", attachmentIds: ["attachment-1", "attachment-2"] },
  { kind: "submit-prompt", text: "no attachments", attachmentIds: [] },
  { kind: "steer-agent", text: "steer text" },
  { kind: "queue-follow-up", text: "follow up text" },
  { kind: "abort-agent" },
  {
    kind: "respond-to-approval",
    approvalRequestId: approvalRequestId("approval-1"),
    allow: true,
    displayedContentHash: new Uint8Array(32).fill(0x11),
  },
  {
    kind: "respond-to-ui",
    uiRequestId: uiRequestId("ui-1"),
    response: new Uint8Array([1, 2, 3]),
    displayedContentHash: new Uint8Array(32).fill(0x22),
  },
  { kind: "set-model", provider: "anthropic", modelId: "claude-sonnet" },
  { kind: "set-thinking-level", level: "high" },
  { kind: "compact-session" },
  { kind: "list-files", relativePath: "src" },
  { kind: "read-file", relativePath: "src/index.ts", offset: 0n, limit: UINT64_MAX },
  { kind: "get-git-diff", staged: true },
  {
    kind: "execute-git-action",
    action: "commit",
    arguments: ["-m", "message"],
    displayedContentHash: new Uint8Array(32).fill(0x33),
  },
  { kind: "list-sessions" },
  { kind: "search-sessions", query: "bug" },
  { kind: "fork-session", sourceSessionId: sessionId("session-1") },
  { kind: "archive-session", sessionId: sessionId("session-1") },
  { kind: "refresh-session-catalog" },
];

for (const command of clientCommandCases) {
  test(`round-trips ClientCommand case: ${command.kind}`, () => {
    roundTrip({
      kind: "command",
      value: {
        commandId: commandId("command-1"),
        sessionId: sessionId("session-1"),
        issuedAtMs: 1_700_000_000_000n,
        expiresAtMs: 1_700_000_030_000n,
        command,
      },
    });
  });
}

test("round-trips ClientCommand with the optional session_id absent", () => {
  const decoded = roundTrip({
    kind: "command",
    value: {
      commandId: commandId("command-1"),
      issuedAtMs: 0n,
      expiresAtMs: 0n,
      command: { kind: "list-sessions" },
    },
  });
  if (decoded.body.kind !== "command") throw new Error("expected command");
  expect(decoded.body.value.sessionId).toBeUndefined();
});

test("rejects a SecurePayload with a mismatched protocol version", () => {
  const bytes = toBinary(
    SecurePayloadSchema,
    create(SecurePayloadSchema, {
      protocolVersion: SESSION_PROTOCOL_VERSION + 1,
      capabilitySet: "",
      body: { case: "error", value: { code: "x", message: "y", retryable: false } },
    }),
  );
  expect(() => decodeSecurePayload(bytes)).toThrow(SessionProtocolError);
  expectSessionProtocolError(() => decodeSecurePayload(bytes), "PROTOCOL_VERSION_MISMATCH");
});

test("rejects a SecurePayload with no body set", () => {
  const bytes = toBinary(
    SecurePayloadSchema,
    create(SecurePayloadSchema, {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      capabilitySet: "",
    }),
  );
  expectSessionProtocolError(() => decodeSecurePayload(bytes), "EMPTY_BODY");
});

test("rejects a ClientCommand with no command set", () => {
  const bytes = toBinary(
    SecurePayloadSchema,
    create(SecurePayloadSchema, {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      capabilitySet: "",
      body: {
        case: "command",
        value: create(ClientCommandSchema, {
          commandId: "command-1",
          issuedAtMs: 0n,
          expiresAtMs: 0n,
        }),
      },
    }),
  );
  expectSessionProtocolError(() => decodeSecurePayload(bytes), "EMPTY_BODY");
});

test("rejects an empty SecurePayload buffer", () => {
  expectSessionProtocolError(() => decodeSecurePayload(new Uint8Array()), "MALFORMED_PAYLOAD");
});

test("rejects a corrupted SecurePayload buffer", () => {
  const malformed = new Uint8Array([
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  expectSessionProtocolError(() => decodeSecurePayload(malformed), "MALFORMED_PAYLOAD");
});

test("rejects a SecurePayload larger than the maximum size on decode", () => {
  const oversized = new Uint8Array(SECURE_PAYLOAD_MAX_BYTES + 1);
  expectSessionProtocolError(() => decodeSecurePayload(oversized), "PAYLOAD_TOO_LARGE");
});

test("rejects encoding a SecurePayload larger than the maximum size", () => {
  const oversized: SecurePayloadBody = {
    capabilitySet: "",
    body: {
      kind: "session-snapshot",
      value: {
        sessionId: sessionId("session-1"),
        revision: 1n,
        stateHash: "hash",
        baseEventSequence: 0n,
        projection: new Uint8Array(SECURE_PAYLOAD_MAX_BYTES + 1_000),
        sessionFileId: "file-1",
        canonicalPathHash: "path-hash",
        recordedCwd: "/workspace",
        ownershipState: "idle",
        ownershipEpoch: 0n,
        compatibilityState: "fully-compatible",
        sdkVersion: "1.0.0",
        tuiVersion: "1.0.0",
        runtimeGeneration: 0n,
        activeRunState: "idle",
        pendingInteractionCount: 0,
        lastStableFileFingerprint: "fingerprint",
      },
    },
  };
  expectSessionProtocolError(() => encodeSecurePayload(oversized), "PAYLOAD_TOO_LARGE");
});

test("rejects a SessionEvent missing session_id", () => {
  const bytes = toBinary(
    SecurePayloadSchema,
    create(SecurePayloadSchema, {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      capabilitySet: "",
      body: {
        case: "sessionEvent",
        value: create(SessionEventSchema, {
          eventId: "event-1",
          hostId: "host-1",
          revision: 1n,
          createdAtMs: 0n,
          runtimeGeneration: 0n,
          kind: "agent-started",
          payload: new Uint8Array(),
        }),
      },
    }),
  );
  expectSessionProtocolError(() => decodeSecurePayload(bytes), "MISSING_REQUIRED_FIELD");
});

test("rejects a SessionEvent missing runtime_generation", () => {
  const bytes = toBinary(
    SecurePayloadSchema,
    create(SecurePayloadSchema, {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      capabilitySet: "",
      body: {
        case: "sessionEvent",
        value: create(SessionEventSchema, {
          eventId: "event-1",
          hostId: "host-1",
          sessionId: "session-1",
          revision: 1n,
          createdAtMs: 0n,
          kind: "agent-started",
          payload: new Uint8Array(),
        }),
      },
    }),
  );
  expectSessionProtocolError(() => decodeSecurePayload(bytes), "MISSING_REQUIRED_FIELD");
});

test("preserves bigint precision beyond Number.MAX_SAFE_INTEGER", () => {
  const decoded = roundTrip({
    kind: "command-accepted",
    value: {
      commandId: commandId("command-1"),
      runtimeId: "runtime-1",
      runtimeGeneration: UINT64_MAX,
    },
  });
  if (decoded.body.kind !== "command-accepted") throw new Error("expected command-accepted");
  expect(typeof decoded.body.value.runtimeGeneration).toBe("bigint");
  expect(decoded.body.value.runtimeGeneration).toBe(UINT64_MAX);
});

// ---------------------------------------------------------------------------
// sealSecurePayload / openSecurePayload
// ---------------------------------------------------------------------------

class FixedRandom implements RandomSource {
  public constructor(private readonly fill: number) {}
  public bytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(this.fill);
  }
}

const pairwiseKey = new Uint8Array(AEAD_KEY_BYTES).fill(0x42);
const otherPairwiseKey = new Uint8Array(AEAD_KEY_BYTES).fill(0x24);

const baseEnvelopeMetadata: SecureEnvelopeMetadata = {
  messageId: "message-1",
  routeId: "route-1",
  senderDeviceId: "host-1",
  recipientDeviceId: "mobile-1",
  clientSequence: 1n,
  createdAtMs: 1_800_000_000_000n,
  expiresAtMs: 1_800_000_600_000n,
  keyId: "key-1",
  priority: Priority.NORMAL,
  notificationHint: NotificationHint.WAKE,
};

const deviceHelloBody: SecurePayloadCase = {
  kind: "device-hello",
  value: { deviceId: "device-1", deviceKind: "mobile", capabilities: ["push"] },
};

function toSealedEnvelope(outbound: OutboundEnvelope): SealedEnvelope {
  return create(SealedEnvelopeSchema, {
    messageId: outbound.messageId,
    routeId: outbound.routeId,
    senderDeviceId: outbound.senderDeviceId,
    recipientDeviceId: outbound.recipientDeviceId,
    clientSequence: outbound.clientSequence,
    createdAtMs: outbound.createdAtMs,
    expiresAtMs: outbound.expiresAtMs,
    keyId: outbound.keyId,
    nonce: outbound.nonce,
    ciphertext: outbound.ciphertext,
    priority: outbound.priority,
    notificationHint: outbound.notificationHint,
  });
}

function sealBody(
  body: SecurePayloadCase,
  metadata: SecureEnvelopeMetadata = baseEnvelopeMetadata,
  capabilitySet = "cap-a,cap-b",
): { readonly outbound: OutboundEnvelope; readonly payload: SecurePayloadBody } {
  const payload: SecurePayloadBody = { capabilitySet, body };
  const outbound = sealSecurePayload(pairwiseKey, metadata, payload, new FixedRandom(9));
  return { outbound, payload };
}

function expectAuthenticationFailure(action: () => unknown): void {
  try {
    action();
    throw new Error("expected CryptoContractError to be thrown");
  } catch (error) {
    if (!(error instanceof CryptoContractError)) throw error;
    expect(error.code).toBe("AUTHENTICATION_FAILED");
  }
}

test("seals and opens a device-hello payload through a SealedEnvelope", () => {
  const { outbound, payload } = sealBody(deviceHelloBody);
  expect(outbound.nonce).toEqual(new Uint8Array(24).fill(9));
  expect(openSecurePayload(pairwiseKey, toSealedEnvelope(outbound))).toEqual(payload);
});

test("seals and opens a ClientCommand payload", () => {
  const { outbound, payload } = sealBody({
    kind: "command",
    value: {
      commandId: commandId("command-1"),
      sessionId: sessionId("session-1"),
      issuedAtMs: 1_700_000_000_000n,
      expiresAtMs: 1_700_000_030_000n,
      command: { kind: "steer-agent", text: "steer text" },
    },
  });
  expect(openSecurePayload(pairwiseKey, toSealedEnvelope(outbound))).toEqual(payload);
});

test("seals and opens an error payload", () => {
  const { outbound, payload } = sealBody({
    kind: "error",
    value: { code: "SESSION_NOT_FOUND", message: "no such session", retryable: true },
  });
  expect(openSecurePayload(pairwiseKey, toSealedEnvelope(outbound))).toEqual(payload);
});

test("opens a SecurePayload delivered inside a DeliveredEnvelope", () => {
  const { outbound, payload } = sealBody(deviceHelloBody);
  const delivered = create(DeliveredEnvelopeSchema, {
    serverSequence: 42n,
    envelope: toSealedEnvelope(outbound),
  });
  expect(openSecurePayload(pairwiseKey, delivered)).toEqual(payload);
});

test("rejects a DeliveredEnvelope missing its sealed envelope", () => {
  const delivered = create(DeliveredEnvelopeSchema, { serverSequence: 1n });
  expectSessionProtocolError(
    () => openSecurePayload(pairwiseKey, delivered),
    "MISSING_REQUIRED_FIELD",
  );
});

test("rejects open() when using the wrong pairwise key", () => {
  const { outbound } = sealBody(deviceHelloBody);
  expectAuthenticationFailure(() =>
    openSecurePayload(otherPairwiseKey, toSealedEnvelope(outbound)),
  );
});

test("rejects open() when the ciphertext is tampered", () => {
  const { outbound } = sealBody(deviceHelloBody);
  const tamperedCiphertext = outbound.ciphertext.slice();
  tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1;
  const tampered = toSealedEnvelope({ ...outbound, ciphertext: tamperedCiphertext });
  expectAuthenticationFailure(() => openSecurePayload(pairwiseKey, tampered));
});

test("rejects open() when the nonce is tampered", () => {
  const { outbound } = sealBody(deviceHelloBody);
  const tamperedNonce = outbound.nonce.slice();
  tamperedNonce[0] = (tamperedNonce[0] ?? 0) ^ 1;
  const tampered = toSealedEnvelope({ ...outbound, nonce: tamperedNonce });
  expectAuthenticationFailure(() => openSecurePayload(pairwiseKey, tampered));
});

test("rejects sealSecurePayload with an invalid pairwise key length", () => {
  const shortKey = new Uint8Array(AEAD_KEY_BYTES - 1);
  expectSessionProtocolError(
    () =>
      sealSecurePayload(
        shortKey,
        baseEnvelopeMetadata,
        { capabilitySet: "", body: deviceHelloBody },
        new FixedRandom(1),
      ),
    "INVALID_KEY_LENGTH",
  );
});

test("rejects openSecurePayload with an invalid pairwise key length", () => {
  const { outbound } = sealBody(deviceHelloBody);
  const shortKey = new Uint8Array(AEAD_KEY_BYTES - 1);
  expectSessionProtocolError(
    () => openSecurePayload(shortKey, toSealedEnvelope(outbound)),
    "INVALID_KEY_LENGTH",
  );
});

test("rejects sealSecurePayload with an empty required field", () => {
  expectSessionProtocolError(
    () =>
      sealSecurePayload(
        pairwiseKey,
        { ...baseEnvelopeMetadata, messageId: "" },
        { capabilitySet: "", body: deviceHelloBody },
        new FixedRandom(1),
      ),
    "MISSING_REQUIRED_FIELD",
  );
});

test("rejects openSecurePayload with an empty required field", () => {
  const { outbound } = sealBody(deviceHelloBody);
  const sealedEnvelope = toSealedEnvelope({ ...outbound, routeId: "" });
  expectSessionProtocolError(
    () => openSecurePayload(pairwiseKey, sealedEnvelope),
    "MISSING_REQUIRED_FIELD",
  );
});

const envelopeTamperCases: readonly {
  readonly field: string;
  readonly apply: (outbound: OutboundEnvelope) => OutboundEnvelope;
}[] = [
  { field: "message_id", apply: (e) => ({ ...e, messageId: `${e.messageId}-tampered` }) },
  { field: "route_id", apply: (e) => ({ ...e, routeId: `${e.routeId}-tampered` }) },
  { field: "sender_device_id", apply: (e) => ({ ...e, senderDeviceId: "impersonator-device" }) },
  {
    field: "recipient_device_id",
    apply: (e) => ({ ...e, recipientDeviceId: "impersonator-device" }),
  },
  { field: "client_sequence", apply: (e) => ({ ...e, clientSequence: e.clientSequence + 1n }) },
  { field: "created_at_ms", apply: (e) => ({ ...e, createdAtMs: e.createdAtMs + 1n }) },
  { field: "expires_at_ms", apply: (e) => ({ ...e, expiresAtMs: e.expiresAtMs + 1n }) },
  { field: "key_id", apply: (e) => ({ ...e, keyId: `${e.keyId}-tampered` }) },
  { field: "priority", apply: (e) => ({ ...e, priority: Priority.HIGH }) },
  {
    field: "notification_hint",
    apply: (e) => ({ ...e, notificationHint: NotificationHint.NONE }),
  },
];

for (const { field, apply } of envelopeTamperCases) {
  test(`rejects open() when ${field} is tampered after seal (AAD is authenticated)`, () => {
    const { outbound } = sealBody(deviceHelloBody);
    const tampered = toSealedEnvelope(apply(outbound));
    expectAuthenticationFailure(() => openSecurePayload(pairwiseKey, tampered));
  });
}

// ---------------------------------------------------------------------------
// sealEnvelope / openEnvelope (bytes-level, used by HostEnvelopeCrypto adapters)
// ---------------------------------------------------------------------------

test("sealEnvelope/openEnvelope round-trip arbitrary plaintext bytes without going through SecurePayload", () => {
  const plaintext = new Uint8Array([1, 2, 3, 4, 5]);
  const outbound = sealEnvelope(pairwiseKey, baseEnvelopeMetadata, plaintext, new FixedRandom(3));
  expect(outbound.nonce).toEqual(new Uint8Array(24).fill(3));
  const opened = openEnvelope(pairwiseKey, toSealedEnvelope(outbound));
  expect(opened).toEqual(plaintext);
});

test("sealSecurePayload/openSecurePayload are implemented in terms of sealEnvelope/openEnvelope", () => {
  const payload: SecurePayloadBody = { capabilitySet: "cap-a", body: deviceHelloBody };
  const viaSecurePayload = sealSecurePayload(
    pairwiseKey,
    baseEnvelopeMetadata,
    payload,
    new FixedRandom(5),
  );
  const viaEnvelope = sealEnvelope(
    pairwiseKey,
    baseEnvelopeMetadata,
    encodeSecurePayload(payload),
    new FixedRandom(5),
  );
  expect(viaSecurePayload).toEqual(viaEnvelope);
  expect(openEnvelope(pairwiseKey, toSealedEnvelope(viaSecurePayload))).toEqual(
    encodeSecurePayload(payload),
  );
});

test("openEnvelope rejects the wrong pairwise key", () => {
  const outbound = sealEnvelope(
    pairwiseKey,
    baseEnvelopeMetadata,
    new Uint8Array([9, 9]),
    new FixedRandom(1),
  );
  expectAuthenticationFailure(() => openEnvelope(otherPairwiseKey, toSealedEnvelope(outbound)));
});

test("sealEnvelope rejects an invalid pairwise key length", () => {
  const shortKey = new Uint8Array(AEAD_KEY_BYTES - 1);
  expectSessionProtocolError(
    () => sealEnvelope(shortKey, baseEnvelopeMetadata, new Uint8Array([1]), new FixedRandom(1)),
    "INVALID_KEY_LENGTH",
  );
});

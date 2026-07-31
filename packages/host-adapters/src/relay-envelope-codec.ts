// Shared structural validation for the relay wire envelope shape
// (OutboundEnvelope / SealedEnvelope from proto/relay/v1 -- both messages
// declare the exact same field set).
//
// host-core deliberately types HostOutboxItem.encrypted and
// HostInboundEnvelope.encrypted as `unknown` (see packages/host-core/src/
// index.ts): RelayGateway and HostEnvelopeCrypto are two independent adapter
// implementations and neither may assume what the other produced. This
// module validates an `unknown` value structurally (every field of the wire
// envelope, including enum membership) and reconstructs it as a genuine
// protobuf message via `create()`, so callers never need an unsafe `as` cast
// at the `unknown` boundary.

import { create } from "@bufbuild/protobuf";
import {
  NotificationHint,
  type OutboundEnvelope,
  OutboundEnvelopeSchema,
  Priority,
  type SealedEnvelope,
  SealedEnvelopeSchema,
} from "@pocket-omp/proto/relay/v1";

interface RawEnvelopeFields {
  readonly messageId: string;
  readonly routeId: string;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  readonly clientSequence: bigint;
  readonly createdAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly keyId: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly priority: Priority;
  readonly notificationHint: NotificationHint;
}

export function outboundEnvelopeFromUnknown(
  value: unknown,
  invalid: (message: string) => Error,
): OutboundEnvelope {
  return create(OutboundEnvelopeSchema, rawEnvelopeFields(value, invalid));
}

export function sealedEnvelopeFromUnknown(
  value: unknown,
  invalid: (message: string) => Error,
): SealedEnvelope {
  return create(SealedEnvelopeSchema, rawEnvelopeFields(value, invalid));
}

function rawEnvelopeFields(value: unknown, invalid: (message: string) => Error): RawEnvelopeFields {
  if (
    typeof value !== "object" ||
    value === null ||
    !("messageId" in value) ||
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    !("routeId" in value) ||
    typeof value.routeId !== "string" ||
    value.routeId.length === 0 ||
    !("senderDeviceId" in value) ||
    typeof value.senderDeviceId !== "string" ||
    value.senderDeviceId.length === 0 ||
    !("recipientDeviceId" in value) ||
    typeof value.recipientDeviceId !== "string" ||
    value.recipientDeviceId.length === 0 ||
    !("clientSequence" in value) ||
    typeof value.clientSequence !== "bigint" ||
    !("createdAtMs" in value) ||
    typeof value.createdAtMs !== "bigint" ||
    !("expiresAtMs" in value) ||
    typeof value.expiresAtMs !== "bigint" ||
    !("keyId" in value) ||
    typeof value.keyId !== "string" ||
    value.keyId.length === 0 ||
    !("nonce" in value) ||
    !(value.nonce instanceof Uint8Array) ||
    !("ciphertext" in value) ||
    !(value.ciphertext instanceof Uint8Array) ||
    !("priority" in value) ||
    typeof value.priority !== "number" ||
    !isPriority(value.priority) ||
    !("notificationHint" in value) ||
    typeof value.notificationHint !== "number" ||
    !isNotificationHint(value.notificationHint)
  ) {
    throw invalid("Value is not a sealed relay envelope");
  }
  return {
    messageId: value.messageId,
    routeId: value.routeId,
    senderDeviceId: value.senderDeviceId,
    recipientDeviceId: value.recipientDeviceId,
    clientSequence: value.clientSequence,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    keyId: value.keyId,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    priority: value.priority,
    notificationHint: value.notificationHint,
  };
}

// Widened to plain `number` sets (rather than comparing `value` directly
// against enum members) so this stays a same-type comparison: `value` here
// is narrowed from `unknown` via `typeof value === "number"`, and comparing
// a bare `number` against an enum-typed member trips
// typescript/no-unsafe-enum-comparison.
const PRIORITY_VALUES: ReadonlySet<number> = new Set([
  Priority.UNSPECIFIED,
  Priority.NORMAL,
  Priority.HIGH,
]);
const NOTIFICATION_HINT_VALUES: ReadonlySet<number> = new Set([
  NotificationHint.UNSPECIFIED,
  NotificationHint.NONE,
  NotificationHint.WAKE,
  NotificationHint.ATTENTION_REQUIRED,
  NotificationHint.RUN_FINISHED,
]);

function isPriority(value: number): value is Priority {
  return PRIORITY_VALUES.has(value);
}

function isNotificationHint(value: number): value is NotificationHint {
  return NOTIFICATION_HINT_VALUES.has(value);
}

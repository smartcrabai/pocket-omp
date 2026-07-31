import { create } from "@bufbuild/protobuf";
import {
  NotificationHint,
  type OutboundEnvelope,
  OutboundEnvelopeSchema,
  Priority,
  type SealedEnvelope,
  SealedEnvelopeSchema,
} from "@pocket-omp/proto/relay/v1";
import { expect, test } from "bun:test";
import {
  outboundEnvelopeFromUnknown,
  sealedEnvelopeFromUnknown,
} from "../src/relay-envelope-codec";

// rawEnvelopeFields (the shared validator behind both *FromUnknown exports)
// throws whatever `invalid(message)` returns, so every test just needs a
// stand-in that mirrors real call sites (see envelope-crypto.test.ts /
// relay-gateway.test.ts).
function invalid(message: string): Error {
  return new Error(message);
}

const INVALID_MESSAGE = "Value is not a sealed relay envelope";

// A plain, unknown-typed object satisfying every field rawEnvelopeFields
// checks -- deliberately not built via `create()`, since the whole point of
// this codec is to validate values that never went through the proto
// builder (e.g. something decoded off the wire as plain JSON-ish data).
function validRawEnvelope(): Record<string, unknown> {
  return {
    messageId: "message-1",
    routeId: "route-1",
    senderDeviceId: "host-1",
    recipientDeviceId: "mobile-1",
    clientSequence: 1n,
    createdAtMs: 1_800_000_000_000n,
    expiresAtMs: 1_800_000_600_000n,
    keyId: "key-1",
    nonce: new Uint8Array(24).fill(1),
    ciphertext: new Uint8Array([1, 2, 3]),
    priority: Priority.NORMAL,
    notificationHint: NotificationHint.NONE,
  };
}

function expectedOutbound(): OutboundEnvelope {
  return create(OutboundEnvelopeSchema, validRawEnvelope());
}

function expectedSealed(): SealedEnvelope {
  return create(SealedEnvelopeSchema, validRawEnvelope());
}

function expectBothReject(raw: unknown): void {
  expect(() => outboundEnvelopeFromUnknown(raw, invalid)).toThrow(INVALID_MESSAGE);
  expect(() => sealedEnvelopeFromUnknown(raw, invalid)).toThrow(INVALID_MESSAGE);
}

test("a fully valid raw envelope round-trips through outboundEnvelopeFromUnknown", () => {
  expect(outboundEnvelopeFromUnknown(validRawEnvelope(), invalid)).toEqual(expectedOutbound());
});

test("a fully valid raw envelope round-trips through sealedEnvelopeFromUnknown", () => {
  expect(sealedEnvelopeFromUnknown(validRawEnvelope(), invalid)).toEqual(expectedSealed());
});

test("non-object and null values are rejected", () => {
  expectBothReject("not an envelope");
  expectBothReject(null);
  expectBothReject(42);
});

// One case per validation branch in rawEnvelopeFields's condition, each
// built by mutating exactly one field of an otherwise-fully-valid envelope.
// This is the coverage gap the review flagged: without these, a copy-paste
// bug that dropped or duplicated a single check would pass silently.
const invalidMutations: ReadonlyArray<{
  readonly name: string;
  readonly overrides: Record<string, unknown>;
}> = [
  { name: "messageId is not a string", overrides: { messageId: 123 } },
  { name: "messageId is an empty string", overrides: { messageId: "" } },
  { name: "routeId is not a string", overrides: { routeId: 123 } },
  { name: "routeId is an empty string", overrides: { routeId: "" } },
  { name: "senderDeviceId is not a string", overrides: { senderDeviceId: 123 } },
  { name: "senderDeviceId is an empty string", overrides: { senderDeviceId: "" } },
  { name: "recipientDeviceId is not a string", overrides: { recipientDeviceId: 123 } },
  { name: "recipientDeviceId is an empty string", overrides: { recipientDeviceId: "" } },
  { name: "clientSequence is not a bigint", overrides: { clientSequence: 1 } },
  { name: "createdAtMs is not a bigint", overrides: { createdAtMs: 1_800_000_000_000 } },
  { name: "expiresAtMs is not a bigint", overrides: { expiresAtMs: 1_800_000_600_000 } },
  { name: "keyId is not a string", overrides: { keyId: 123 } },
  { name: "keyId is an empty string", overrides: { keyId: "" } },
  { name: "nonce is not a Uint8Array", overrides: { nonce: [1, 2, 3] } },
  { name: "ciphertext is not a Uint8Array", overrides: { ciphertext: "not bytes" } },
  { name: "priority is not a number", overrides: { priority: "NORMAL" } },
  { name: "priority is an out-of-range enum value", overrides: { priority: 99 } },
  { name: "notificationHint is not a number", overrides: { notificationHint: "NONE" } },
  { name: "notificationHint is an out-of-range enum value", overrides: { notificationHint: 99 } },
];

for (const { name, overrides } of invalidMutations) {
  test(`rejects a raw envelope where ${name}`, () => {
    expectBothReject({ ...validRawEnvelope(), ...overrides });
  });
}

// Separately from wrong-type/out-of-range values, each field must also be
// *present* -- rawEnvelopeFields checks `"field" in value` before it ever
// looks at the value's type.
for (const field of Object.keys(validRawEnvelope())) {
  test(`rejects a raw envelope missing ${field}`, () => {
    const raw = validRawEnvelope();
    delete raw[field];
    expectBothReject(raw);
  });
}

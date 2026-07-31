import { eventId, sessionId } from "@pocket-omp/agent-domain";
import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import type { MobileRelayFrame } from "@pocket-omp/mobile-core";
import { NotificationHint, Priority, SealedEnvelopeSchema } from "@pocket-omp/proto/relay/v1";
import {
  encodeTranscriptEvent,
  sealSecurePayload,
  type SecurePayloadBody,
} from "@pocket-omp/session-protocol";
import {
  MalformedRelayFrameError,
  MissingPairwiseKeyError,
  routePairwiseKeyKey,
  SecureStoreEnvelopeCrypto,
  type PairwiseKeyStore,
} from "../src/relay-crypto";

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function fakeKeyStore(entries: Readonly<Record<string, string>> = {}): PairwiseKeyStore {
  return { getItemAsync: (key) => Promise.resolve(entries[key] ?? null) };
}

function sealedFrame(
  routeId: string,
  pairwiseKey: Uint8Array,
  body: SecurePayloadBody,
): MobileRelayFrame {
  const outbound = sealSecurePayload(
    pairwiseKey,
    {
      messageId: "envelope-message-1",
      routeId,
      senderDeviceId: "host-device",
      recipientDeviceId: "mobile-device",
      clientSequence: 1n,
      createdAtMs: 1_700_000_000_000n,
      expiresAtMs: 1_700_000_600_000n,
      keyId: "key-1",
      priority: Priority.NORMAL,
      notificationHint: NotificationHint.NONE,
    },
    body,
    { bytes: randomBytes },
  );
  const encrypted = create(SealedEnvelopeSchema, {
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
  return { serverSequence: 1n, generation: "g1", eventId: outbound.messageId, encrypted };
}

describe("routePairwiseKeyKey", () => {
  test("matches the route.{routeId}.key convention established by app/pair.tsx", () => {
    expect(routePairwiseKeyKey("route-1")).toBe("route.route-1.key");
  });
});

describe("SecureStoreEnvelopeCrypto", () => {
  test("decrypts a sealed session-event envelope using the pairwise key stored for its route", async () => {
    const pairwiseKey = randomBytes(32);
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: {
        kind: "session-event",
        value: {
          eventId: eventId("event-1"),
          sessionId: sessionId("session-1"),
          revision: 7n,
          createdAtMs: 1_700_000_000_000n,
          runtimeGeneration: 1n,
          hostId: "host-1",
          kind: "message-completed",
          payload: encodeTranscriptEvent({ kind: "message-completed", messageId: "message-1" }),
        },
      },
    };
    const frame = sealedFrame("route-1", pairwiseKey, body);
    const crypto2 = new SecureStoreEnvelopeCrypto(
      fakeKeyStore({ "route.route-1.key": toBase64(pairwiseKey) }),
    );
    const event = await crypto2.open(frame);
    expect(event.eventId).toBe("event-1");
    expect(event.sessionId).toBe("session-1");
    expect(event.revision).toBe(7n);
    expect(event.kind).toBe("message-completed");
    expect(event.payload).toEqual({ kind: "message-completed", messageId: "message-1" });
  });

  test("throws MissingPairwiseKeyError when no key is stored for the envelope's route", async () => {
    const pairwiseKey = randomBytes(32);
    const body: SecurePayloadBody = {
      capabilitySet: "v1",
      body: { kind: "error", value: { code: "X", message: "y", retryable: false } },
    };
    const frame = sealedFrame("route-unknown", pairwiseKey, body);
    const crypto2 = new SecureStoreEnvelopeCrypto(fakeKeyStore());
    await expect(crypto2.open(frame)).rejects.toBeInstanceOf(MissingPairwiseKeyError);
  });

  test("throws MalformedRelayFrameError when frame.encrypted is not a sealed envelope", async () => {
    const crypto2 = new SecureStoreEnvelopeCrypto(fakeKeyStore());
    const frame: MobileRelayFrame = {
      serverSequence: 1n,
      generation: "g1",
      eventId: "event-1",
      encrypted: { not: "an envelope" },
    };
    await expect(crypto2.open(frame)).rejects.toBeInstanceOf(MalformedRelayFrameError);
  });
});

import { expect, test } from "bun:test";
import {
  E2EE_PROTOCOL_VERSION,
  canonicalEnvelopeAad,
  canonicalKeyRotationStatement,
  derivePairwiseKey,
  deriveRotatedPairwiseKey,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  open,
  pairingConfirmationCode,
  pairingTranscriptHash,
  seal,
  signDeviceStatement,
  verifyDeviceStatement,
  type EnvelopeMetadata,
  type RandomSource,
} from "../src/index";

class FixedRandom implements RandomSource {
  public constructor(private readonly fill: number) {}
  public bytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(this.fill);
  }
}

const metadata: EnvelopeMetadata = {
  protocolVersion: E2EE_PROTOCOL_VERSION,
  messageId: "message-1",
  routeId: "route-1",
  senderDeviceId: "host-1",
  recipientDeviceId: "mobile-1",
  clientSequence: 1n,
  createdAtMs: 1_800_000_000_000n,
  expiresAtMs: 1_800_000_600_000n,
  keyId: "key-1",
  priority: 2,
  notificationHint: 2,
};

test("pairwise X25519 keys encrypt independently authenticated envelopes", () => {
  const host = generateX25519KeyPair(new FixedRandom(1));
  const mobile = generateX25519KeyPair(new FixedRandom(2));
  const transcriptHash = pairingTranscriptHash({
    protocolVersion: E2EE_PROTOCOL_VERSION,
    serviceIdentifier: "pocket-omp",
    pairingId: "pairing-1",
    challenge: new Uint8Array(32).fill(3),
    hostPublicKey: host.publicKey,
    mobilePublicKey: mobile.publicKey,
    expiresAtMs: 1_800_000_300_000n,
  });
  const hostKey = derivePairwiseKey({
    localSecretKey: host.secretKey,
    peerPublicKey: mobile.publicKey,
    pairingTranscriptHash: transcriptHash,
    routeId: metadata.routeId,
    localDeviceId: metadata.senderDeviceId,
    peerDeviceId: metadata.recipientDeviceId,
  });
  const mobileKey = derivePairwiseKey({
    localSecretKey: mobile.secretKey,
    peerPublicKey: host.publicKey,
    pairingTranscriptHash: transcriptHash,
    routeId: metadata.routeId,
    localDeviceId: metadata.recipientDeviceId,
    peerDeviceId: metadata.senderDeviceId,
  });
  expect(hostKey).toEqual(mobileKey);
  const plaintext = new TextEncoder().encode("encrypted session command");
  const encrypted = seal(hostKey, metadata, plaintext, new FixedRandom(4));
  expect(open(mobileKey, metadata, encrypted)).toEqual(plaintext);
  expect(() => open(mobileKey, { ...metadata, clientSequence: 2n }, encrypted)).toThrow(
    "AUTHENTICATION_FAILED",
  );
  const tampered = encrypted.ciphertext.slice();
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  expect(() => open(mobileKey, metadata, { ...encrypted, ciphertext: tampered })).toThrow(
    "AUTHENTICATION_FAILED",
  );
  expect(pairingConfirmationCode(new Uint8Array([1, 2, 3]), hostKey)).toMatch(/^\d{6}$/);
});

test("key rotation is route-bound, generation-bound, and device-signed", () => {
  const currentKey = new Uint8Array(32).fill(5);
  const rotated = deriveRotatedPairwiseKey(currentKey, "route-1", "key-2", 2n);
  expect(rotated).not.toEqual(deriveRotatedPairwiseKey(currentKey, "route-1", "key-3", 2n));
  expect(rotated).not.toEqual(deriveRotatedPairwiseKey(currentKey, "route-1", "key-2", 3n));
  const deviceSigning = generateEd25519KeyPair(new FixedRandom(6));
  const statement = canonicalKeyRotationStatement({
    protocolVersion: E2EE_PROTOCOL_VERSION,
    routeId: "route-1",
    deviceId: "host-1",
    previousKeyId: "key-1",
    newKeyId: "key-2",
    newPublicKey: new Uint8Array(32).fill(7),
    generation: 2n,
    issuedAtMs: 1_800_000_000_000n,
  });
  const signature = signDeviceStatement(deviceSigning.secretKey, statement);
  expect(verifyDeviceStatement(deviceSigning.publicKey, statement, signature)).toBeTrue();
  const changed = statement.slice();
  changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
  expect(verifyDeviceStatement(deviceSigning.publicKey, changed, signature)).toBeFalse();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("TypeScript reproduces the checked-in E2EE v1 interoperability vector", async () => {
  const raw: unknown = await Bun.file(new URL("../vectors/e2ee-v1.json", import.meta.url)).json();
  if (!isRecord(raw)) {
    throw new Error("Invalid E2EE vector");
  }
  const vectorValue = (name: string): string | number => {
    if (!(name in raw) || (typeof raw[name] !== "string" && typeof raw[name] !== "number")) {
      throw new Error(`Invalid E2EE vector field ${name}`);
    }
    return raw[name];
  };
  const fromHex = (name: string): Uint8Array => Uint8Array.fromHex(String(vectorValue(name)));
  const host = generateX25519KeyPair({ bytes: () => fromHex("host_secret_key") });
  const transcriptHash = pairingTranscriptHash({
    protocolVersion: Number(vectorValue("protocol_version")),
    serviceIdentifier: String(vectorValue("service_identifier")),
    pairingId: String(vectorValue("pairing_id")),
    challenge: fromHex("challenge"),
    hostPublicKey: host.publicKey,
    mobilePublicKey: fromHex("mobile_public_key"),
    expiresAtMs: BigInt(vectorValue("pairing_expires_at_ms")),
  });
  expect(host.publicKey).toEqual(fromHex("host_public_key"));
  expect(transcriptHash).toEqual(fromHex("transcript_hash"));
  const key = derivePairwiseKey({
    localSecretKey: fromHex("host_secret_key"),
    peerPublicKey: fromHex("mobile_public_key"),
    pairingTranscriptHash: transcriptHash,
    routeId: String(vectorValue("route_id")),
    localDeviceId: String(vectorValue("sender_device_id")),
    peerDeviceId: String(vectorValue("recipient_device_id")),
  });
  expect(key).toEqual(fromHex("pairwise_key"));
  const envelopeMetadata: EnvelopeMetadata = {
    protocolVersion: Number(vectorValue("protocol_version")),
    messageId: String(vectorValue("message_id")),
    routeId: String(vectorValue("route_id")),
    senderDeviceId: String(vectorValue("sender_device_id")),
    recipientDeviceId: String(vectorValue("recipient_device_id")),
    clientSequence: BigInt(vectorValue("client_sequence")),
    createdAtMs: BigInt(vectorValue("created_at_ms")),
    expiresAtMs: BigInt(vectorValue("expires_at_ms")),
    keyId: String(vectorValue("key_id")),
    priority: Number(vectorValue("priority")),
    notificationHint: Number(vectorValue("notification_hint")),
  };
  expect(canonicalEnvelopeAad(envelopeMetadata)).toEqual(fromHex("aad"));
  expect(
    seal(key, envelopeMetadata, fromHex("plaintext"), { bytes: () => fromHex("nonce") }).ciphertext,
  ).toEqual(fromHex("ciphertext"));
  expect(
    open(key, envelopeMetadata, { nonce: fromHex("nonce"), ciphertext: fromHex("ciphertext") }),
  ).toEqual(fromHex("plaintext"));
});

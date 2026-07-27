import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const E2EE_CONTEXT = "pocket-omp/e2ee/v1";
export const E2EE_PROTOCOL_VERSION = 1;
export const X25519_KEY_BYTES = 32;
export const XCHACHA_NONCE_BYTES = 24;
export const AEAD_KEY_BYTES = 32;

export interface KeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export interface EnvelopeMetadata {
  readonly protocolVersion: number;
  readonly messageId: string;
  readonly routeId: string;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  readonly clientSequence: bigint;
  readonly createdAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly keyId: string;
  readonly priority: number;
  readonly notificationHint: number;
}

export interface SealedContent {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export function generateX25519KeyPair(random: RandomSource): KeyPair {
  const secretKey = random.bytes(X25519_KEY_BYTES);
  if (secretKey.byteLength !== X25519_KEY_BYTES) throw new CryptoContractError("INVALID_KEY");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function generateEd25519KeyPair(random: RandomSource): KeyPair {
  const secretKey = random.bytes(32);
  if (secretKey.byteLength !== 32) throw new CryptoContractError("INVALID_KEY");
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function derivePairwiseKey(input: {
  readonly localSecretKey: Uint8Array;
  readonly peerPublicKey: Uint8Array;
  readonly pairingTranscriptHash: Uint8Array;
  readonly routeId: string;
  readonly localDeviceId: string;
  readonly peerDeviceId: string;
}): Uint8Array {
  requireBytes(input.localSecretKey, X25519_KEY_BYTES, "local secret key");
  requireBytes(input.peerPublicKey, X25519_KEY_BYTES, "peer public key");
  requireBytes(input.pairingTranscriptHash, 32, "pairing transcript hash");
  requireIdentifier(input.routeId, "route ID");
  requireIdentifier(input.localDeviceId, "local device ID");
  requireIdentifier(input.peerDeviceId, "peer device ID");
  if (input.localDeviceId === input.peerDeviceId) {
    throw new CryptoContractError("INVALID_ROUTE");
  }
  const sharedSecret = x25519.getSharedSecret(input.localSecretKey, input.peerPublicKey);
  const deviceIds = [input.localDeviceId, input.peerDeviceId].toSorted();
  const info = encodeTuple([
    new TextEncoder().encode(E2EE_CONTEXT),
    new TextEncoder().encode(input.routeId),
    new TextEncoder().encode(deviceIds[0] ?? ""),
    new TextEncoder().encode(deviceIds[1] ?? ""),
  ]);
  return hkdf(sha256, sharedSecret, input.pairingTranscriptHash, info, AEAD_KEY_BYTES);
}

export interface PairingTranscriptInput {
  readonly protocolVersion: number;
  readonly serviceIdentifier: string;
  readonly pairingId: string;
  readonly challenge: Uint8Array;
  readonly hostPublicKey: Uint8Array;
  readonly mobilePublicKey: Uint8Array;
  readonly expiresAtMs: bigint;
}

export function canonicalPairingTranscript(input: PairingTranscriptInput): Uint8Array {
  if (input.protocolVersion !== E2EE_PROTOCOL_VERSION)
    throw new CryptoContractError("PROTOCOL_UNSUPPORTED");
  requireIdentifier(input.serviceIdentifier, "service identifier");
  requireIdentifier(input.pairingId, "pairing ID");
  requireBytes(input.challenge, 32, "pairing challenge");
  requireBytes(input.hostPublicKey, X25519_KEY_BYTES, "host public key");
  requireBytes(input.mobilePublicKey, X25519_KEY_BYTES, "mobile public key");
  return encodeTuple([
    new TextEncoder().encode("pocket-omp/pairing-transcript/v1"),
    uint32(input.protocolVersion),
    new TextEncoder().encode(input.serviceIdentifier),
    new TextEncoder().encode(input.pairingId),
    input.challenge,
    input.hostPublicKey,
    input.mobilePublicKey,
    int64(input.expiresAtMs),
  ]);
}

export function pairingTranscriptHash(input: PairingTranscriptInput): Uint8Array {
  return sha256(canonicalPairingTranscript(input));
}

export function deriveRotatedPairwiseKey(
  currentKey: Uint8Array,
  routeId: string,
  keyId: string,
  generation: bigint,
): Uint8Array {
  requireBytes(currentKey, AEAD_KEY_BYTES, "current pairwise key");
  requireIdentifier(routeId, "route ID");
  requireIdentifier(keyId, "key ID");
  if (generation <= 0n) throw new CryptoContractError("INTEGER_OUT_OF_RANGE");
  const info = encodeTuple([
    new TextEncoder().encode("pocket-omp/e2ee-key-rotation/v1"),
    new TextEncoder().encode(routeId),
    new TextEncoder().encode(keyId),
    uint64(generation),
  ]);
  return hkdf(sha256, currentKey, undefined, info, AEAD_KEY_BYTES);
}

export function canonicalKeyRotationStatement(input: {
  readonly protocolVersion: number;
  readonly routeId: string;
  readonly deviceId: string;
  readonly previousKeyId: string;
  readonly newKeyId: string;
  readonly newPublicKey: Uint8Array;
  readonly generation: bigint;
  readonly issuedAtMs: bigint;
}): Uint8Array {
  if (input.protocolVersion !== E2EE_PROTOCOL_VERSION)
    throw new CryptoContractError("PROTOCOL_UNSUPPORTED");
  for (const [value, name] of [
    [input.routeId, "route ID"],
    [input.deviceId, "device ID"],
    [input.previousKeyId, "previous key ID"],
    [input.newKeyId, "new key ID"],
  ] as const)
    requireIdentifier(value, name);
  if (input.previousKeyId === input.newKeyId || input.generation <= 0n)
    throw new CryptoContractError("INVALID_KEY");
  requireBytes(input.newPublicKey, X25519_KEY_BYTES, "new public key");
  return encodeTuple([
    new TextEncoder().encode("pocket-omp/key-rotation-statement/v1"),
    uint32(input.protocolVersion),
    new TextEncoder().encode(input.routeId),
    new TextEncoder().encode(input.deviceId),
    new TextEncoder().encode(input.previousKeyId),
    new TextEncoder().encode(input.newKeyId),
    input.newPublicKey,
    uint64(input.generation),
    int64(input.issuedAtMs),
  ]);
}

export function canonicalEnvelopeAad(metadata: EnvelopeMetadata): Uint8Array {
  if (metadata.protocolVersion !== E2EE_PROTOCOL_VERSION) {
    throw new CryptoContractError("PROTOCOL_UNSUPPORTED");
  }
  for (const [value, name] of [
    [metadata.messageId, "message ID"],
    [metadata.routeId, "route ID"],
    [metadata.senderDeviceId, "sender device ID"],
    [metadata.recipientDeviceId, "recipient device ID"],
    [metadata.keyId, "key ID"],
  ] as const) {
    requireIdentifier(value, name);
  }
  if (metadata.senderDeviceId === metadata.recipientDeviceId) {
    throw new CryptoContractError("INVALID_ROUTE");
  }
  return encodeTuple([
    uint32(metadata.protocolVersion),
    new TextEncoder().encode(metadata.messageId),
    new TextEncoder().encode(metadata.routeId),
    new TextEncoder().encode(metadata.senderDeviceId),
    new TextEncoder().encode(metadata.recipientDeviceId),
    uint64(metadata.clientSequence),
    int64(metadata.createdAtMs),
    int64(metadata.expiresAtMs),
    new TextEncoder().encode(metadata.keyId),
    uint32(metadata.priority),
    uint32(metadata.notificationHint),
  ]);
}

export function seal(
  key: Uint8Array,
  metadata: EnvelopeMetadata,
  plaintext: Uint8Array,
  random: RandomSource,
): SealedContent {
  requireBytes(key, AEAD_KEY_BYTES, "AEAD key");
  if (plaintext.byteLength === 0) throw new CryptoContractError("EMPTY_PLAINTEXT");
  const nonce = random.bytes(XCHACHA_NONCE_BYTES);
  requireBytes(nonce, XCHACHA_NONCE_BYTES, "XChaCha nonce");
  const aad = canonicalEnvelopeAad(metadata);
  const ciphertext = xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
  return { nonce, ciphertext };
}

export function open(
  key: Uint8Array,
  metadata: EnvelopeMetadata,
  sealed: SealedContent,
): Uint8Array {
  requireBytes(key, AEAD_KEY_BYTES, "AEAD key");
  requireBytes(sealed.nonce, XCHACHA_NONCE_BYTES, "XChaCha nonce");
  if (sealed.ciphertext.byteLength < 17) throw new CryptoContractError("INVALID_CIPHERTEXT");
  try {
    return xchacha20poly1305(key, sealed.nonce, canonicalEnvelopeAad(metadata)).decrypt(
      sealed.ciphertext,
    );
  } catch (error) {
    throw new CryptoContractError("AUTHENTICATION_FAILED", { cause: error });
  }
}

export function signDeviceStatement(secretKey: Uint8Array, statement: Uint8Array): Uint8Array {
  requireBytes(secretKey, 32, "Ed25519 secret key");
  if (statement.byteLength === 0) throw new CryptoContractError("EMPTY_STATEMENT");
  return ed25519.sign(statement, secretKey);
}

export function verifyDeviceStatement(
  publicKey: Uint8Array,
  statement: Uint8Array,
  signature: Uint8Array,
): boolean {
  requireBytes(publicKey, 32, "Ed25519 public key");
  requireBytes(signature, 64, "Ed25519 signature");
  return ed25519.verify(signature, statement, publicKey, { zip215: false });
}

export function pairingConfirmationCode(transcript: Uint8Array, sharedSecret: Uint8Array): string {
  requireBytes(sharedSecret, 32, "shared secret");
  if (transcript.byteLength === 0) throw new CryptoContractError("EMPTY_TRANSCRIPT");
  const digest = hkdf(
    sha256,
    sharedSecret,
    sha256(transcript),
    new TextEncoder().encode("pocket-omp/pairing-confirmation/v1"),
    4,
  );
  const value = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0, false) % 1_000_000;
  return value.toString().padStart(6, "0");
}

function encodeTuple(values: readonly Uint8Array[]): Uint8Array {
  const totalLength = values.reduce((sum, value) => sum + 4 + value.byteLength, 0);
  const encoded = new Uint8Array(totalLength);
  const view = new DataView(encoded.buffer);
  let offset = 0;
  for (const value of values) {
    view.setUint32(offset, value.byteLength, false);
    offset += 4;
    encoded.set(value, offset);
    offset += value.byteLength;
  }
  return encoded;
}

function uint32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new CryptoContractError("INTEGER_OUT_OF_RANGE");
  }
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value, false);
  return encoded;
}

function uint64(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new CryptoContractError("INTEGER_OUT_OF_RANGE");
  }
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, value, false);
  return encoded;
}

function int64(value: bigint): Uint8Array {
  if (value < -0x8000_0000_0000_0000n || value > 0x7fff_ffff_ffff_ffffn) {
    throw new CryptoContractError("INTEGER_OUT_OF_RANGE");
  }
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigInt64(0, value, false);
  return encoded;
}

function requireIdentifier(value: string, name: string): void {
  if (value.length === 0 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new CryptoContractError("INVALID_IDENTIFIER", { cause: new Error(name) });
  }
}

function requireBytes(value: Uint8Array, expectedLength: number, name: string): void {
  if (value.byteLength !== expectedLength) {
    throw new CryptoContractError("INVALID_LENGTH", { cause: new Error(name) });
  }
}

export class CryptoContractError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_KEY"
      | "INVALID_ROUTE"
      | "PROTOCOL_UNSUPPORTED"
      | "INVALID_IDENTIFIER"
      | "INTEGER_OUT_OF_RANGE"
      | "INVALID_LENGTH"
      | "EMPTY_PLAINTEXT"
      | "INVALID_CIPHERTEXT"
      | "AUTHENTICATION_FAILED"
      | "EMPTY_STATEMENT"
      | "EMPTY_TRANSCRIPT",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "CryptoContractError";
  }
}

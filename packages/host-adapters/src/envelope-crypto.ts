// HostEnvelopeCrypto (host-core) implementation for a single paired route
// (ADR-005 pairwise E2EE). Reads the Host's own device id and the pairwise
// AEAD key from SecureKeyStore under the `route:<routeId>:host-id` /
// `route:<routeId>:pairwise-key` handles written by apps/host/src/pairing.ts,
// and seals/opens using session-protocol's bytes-level sealEnvelope /
// openEnvelope (built on packages/crypto's AEAD primitives).
//
// Symmetry with apps/mobile: every field of SecureEnvelopeMetadata below
// feeds canonicalEnvelopeAad (packages/crypto), so all of them are
// authenticated, not just carried as metadata. Because they travel on the
// wire inside the sealed envelope itself, Mobile does not need to
// independently recompute them to open a message -- it reads them off the
// envelope. The one place a *shared convention* will matter once key
// rotation exists is `keyId`: today there is exactly one pairwise key per
// route and INITIAL_PAIRWISE_KEY_ID is a fixed placeholder, but once
// rotation lands, Host and Mobile will both need to agree on how a keyId
// names/versions a key so the receiving side can resolve which stored key a
// given envelope was sealed with.
import { AEAD_KEY_BYTES, type RandomSource } from "@pocket-omp/crypto";
import type {
  HostEnvelopeCrypto,
  HostInboundEnvelope,
  HostOutboxItem,
  SecureKeyStore,
} from "@pocket-omp/host-core";
import { NotificationHint, Priority } from "@pocket-omp/proto/relay/v1";
import {
  openEnvelope,
  sealEnvelope,
  type SecureEnvelopeMetadata,
} from "@pocket-omp/session-protocol";

import { sealedEnvelopeFromUnknown } from "./relay-envelope-codec";

// 24h default lifetime: comfortably inside the Relay mailbox's accepted
// envelope TTL window (services/control-api/src/relay.ts MIN_TTL_MS = 5m,
// MAX_TTL_MS = 7d), long enough to survive a Mobile device being offline
// overnight without needing a resend.
const DEFAULT_ENVELOPE_TTL_MS = 86_400_000n;

// Key rotation (ADR-005) is not implemented yet: every envelope on a route
// is sealed under that route's single pairing-time pairwise key, so a fixed
// placeholder keyId is enough for now. A follow-up task will replace this
// with a real per-rotation key id read alongside the pairwise key.
const INITIAL_PAIRWISE_KEY_ID = "pairwise-1";

export interface RouteEnvelopeCryptoOptions {
  readonly routeId: string;
  readonly keyStore: SecureKeyStore;
  readonly random: RandomSource;
  readonly now?: () => bigint;
  // Defaults to a deterministic content-address (see defaultMessageId below)
  // rather than a random id; override for tests or for callers with their
  // own idempotency-key convention.
  readonly newMessageId?: (recipientDeviceId: string, plaintext: Uint8Array) => string;
  readonly ttlMs?: bigint;
}

interface RouteKeys {
  readonly hostDeviceId: string;
  readonly pairwiseKey: Uint8Array;
}

export class RouteEnvelopeCrypto implements HostEnvelopeCrypto {
  private readonly routeId: string;
  private readonly keyStore: SecureKeyStore;
  private readonly random: RandomSource;
  private readonly now: () => bigint;
  private readonly newMessageId: (recipientDeviceId: string, plaintext: Uint8Array) => string;
  private readonly ttlMs: bigint;
  private clientSequence = 0n;
  private cachedKeys: Promise<RouteKeys> | undefined;

  public constructor(options: RouteEnvelopeCryptoOptions) {
    if (options.routeId.length === 0) {
      throw new HostEnvelopeCryptoError("INVALID_ROUTE", "routeId must not be empty");
    }
    const ttlMs = options.ttlMs ?? DEFAULT_ENVELOPE_TTL_MS;
    if (ttlMs <= 0n) {
      throw new HostEnvelopeCryptoError("INVALID_TTL", "ttlMs must be positive");
    }
    this.routeId = options.routeId;
    this.keyStore = options.keyStore;
    this.random = options.random;
    this.now = options.now ?? (() => BigInt(Date.now()));
    this.newMessageId = options.newMessageId ?? defaultMessageId;
    this.ttlMs = ttlMs;
  }

  public async seal(recipientDeviceId: string, plaintext: Uint8Array): Promise<HostOutboxItem> {
    if (recipientDeviceId.length === 0) {
      throw new HostEnvelopeCryptoError("INVALID_RECIPIENT", "recipientDeviceId must not be empty");
    }
    const keys = await this.keys();
    const createdAtMs = this.now();
    this.clientSequence += 1n;
    const metadata: SecureEnvelopeMetadata = {
      messageId: this.newMessageId(recipientDeviceId, plaintext),
      routeId: this.routeId,
      senderDeviceId: keys.hostDeviceId,
      recipientDeviceId,
      clientSequence: this.clientSequence,
      createdAtMs,
      expiresAtMs: createdAtMs + this.ttlMs,
      keyId: INITIAL_PAIRWISE_KEY_ID,
      // Priority/notificationHint are content-agnostic defaults: this
      // generic seal() has no visibility into what kind of SecurePayload it
      // is sealing. A follow-up task forwarding real runtime events will
      // need richer inputs to choose these per message kind.
      priority: Priority.NORMAL,
      notificationHint: NotificationHint.NONE,
    };
    const outbound = sealEnvelope(keys.pairwiseKey, metadata, plaintext, this.random);
    return { messageId: metadata.messageId, encrypted: outbound };
  }

  public async open(envelope: HostInboundEnvelope): Promise<Uint8Array> {
    const keys = await this.keys();
    const sealed = sealedEnvelopeFromUnknown(
      envelope.encrypted,
      (message) => new HostEnvelopeCryptoError("INVALID_INBOUND_ENVELOPE", message),
    );
    if (sealed.routeId !== this.routeId) {
      throw new HostEnvelopeCryptoError(
        "ROUTE_MISMATCH",
        "Inbound envelope route_id does not match this route",
      );
    }
    if (sealed.recipientDeviceId !== keys.hostDeviceId) {
      throw new HostEnvelopeCryptoError(
        "RECIPIENT_MISMATCH",
        "Inbound envelope is not addressed to this Host",
      );
    }
    return openEnvelope(keys.pairwiseKey, sealed);
  }

  private async keys(): Promise<RouteKeys> {
    this.cachedKeys ??= this.loadKeys();
    try {
      return await this.cachedKeys;
    } catch (error) {
      this.cachedKeys = undefined;
      throw error;
    }
  }

  private async loadKeys(): Promise<RouteKeys> {
    const [hostIdBytes, pairwiseKey] = await Promise.all([
      this.keyStore.get(routeHandle(this.routeId, "host-id")),
      this.keyStore.get(routeHandle(this.routeId, "pairwise-key")),
    ]);
    if (pairwiseKey === undefined) {
      throw new HostEnvelopeCryptoError(
        "MISSING_PAIRWISE_KEY",
        `No pairwise key is stored for route ${this.routeId}`,
      );
    }
    if (pairwiseKey.byteLength !== AEAD_KEY_BYTES) {
      throw new HostEnvelopeCryptoError(
        "MISSING_PAIRWISE_KEY",
        `Stored pairwise key for route ${this.routeId} has an invalid length`,
      );
    }
    if (hostIdBytes === undefined) {
      throw new HostEnvelopeCryptoError(
        "MISSING_HOST_DEVICE_ID",
        `No host device id is stored for route ${this.routeId}`,
      );
    }
    const hostDeviceId = new TextDecoder().decode(hostIdBytes);
    if (hostDeviceId.length === 0) {
      throw new HostEnvelopeCryptoError(
        "MISSING_HOST_DEVICE_ID",
        `Stored host device id for route ${this.routeId} is empty`,
      );
    }
    return { hostDeviceId, pairwiseKey };
  }
}

function routeHandle(routeId: string, field: string): string {
  return `route:${routeId}:${field}`;
}

// ADR-006 has Relay deduplicate outbound deliveries by
// `sender_device_id + message_id`. A random message_id (the previous
// default here) only dedupes a *single* outbox row that gets republished by
// flushOutbox() before being acknowledged -- it does nothing for a caller
// that calls seal() a second time for logically the same message (e.g. Host
// re-forwarding an Agent Runtime event it already forwarded once, after a
// restart or a transient failure upstream of enqueue()). A random id makes
// that second seal() produce a brand-new outbox row and a second delivery.
//
// Deriving message_id deterministically from (recipientDeviceId, plaintext)
// instead means calling seal() twice for the same recipient+content always
// produces the same message_id, so:
//   - HostSqliteDeliveryStore.appendOutbox's message_id PRIMARY KEY already
//     collapses the retry locally, before it ever reaches Relay.
//   - Even if the retry reached Relay some other way, Relay's own
//     sender_device_id + message_id dedup (ADR-006) collapses it there too.
// A sha256 hash is used only as a stable content address, not for secrecy;
// hashing recipientDeviceId in as well keeps two different recipients that
// happen to receive byte-identical plaintext from colliding on the same id
// (they are, correctly, two distinct deliveries).
//
// This is safe specifically because every distinct logical message this
// codebase seals carries its own identity inside the plaintext (e.g. a
// session-event's eventId+revision, packages/session-protocol's SessionEvent)
// -- so two genuinely different messages to the same recipient always
// differ in plaintext bytes, and only true retries of the same message ever
// share both recipient and plaintext.
function defaultMessageId(recipientDeviceId: string, plaintext: Uint8Array): string {
  // Separated by a NUL byte so a crafted recipientDeviceId cannot shift
  // bytes across the boundary and collide with a different
  // (recipientDeviceId, plaintext) pair (device ids are UUIDs in practice
  // and never contain one, but this removes the ambiguity outright).
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(recipientDeviceId);
  hasher.update(" ");
  hasher.update(plaintext);
  return hasher.digest("hex");
}

export class HostEnvelopeCryptoError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_ROUTE"
      | "INVALID_TTL"
      | "INVALID_RECIPIENT"
      | "MISSING_PAIRWISE_KEY"
      | "MISSING_HOST_DEVICE_ID"
      | "INVALID_INBOUND_ENVELOPE"
      | "ROUTE_MISMATCH"
      | "RECIPIENT_MISMATCH",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostEnvelopeCryptoError";
  }
}

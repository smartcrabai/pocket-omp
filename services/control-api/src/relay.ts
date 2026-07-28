import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  AcceptedSchema,
  AckRequestSchema,
  AckResponseSchema,
  DeliveredEnvelopeSchema,
  EncryptedSnapshotSchema,
  GetSnapshotRequestSchema,
  GetSnapshotResponseSchema,
  NotificationHint,
  type OutboundEnvelope,
  OutboundEnvelopeSchema,
  PublishRequestSchema,
  PublishResponseSchema,
  PublishResultSchema,
  PutSnapshotRequestSchema,
  PutSnapshotResponseSchema,
  RejectedSchema,
  RelayFrameSchema,
  SealedEnvelopeSchema,
} from "@pocket-omp/proto/relay/v1";
import { DurableObject } from "cloudflare:workers";

const MAX_ENVELOPES = 64;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const MIN_TTL_MS = 5 * 60 * 1_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_IN_FLIGHT = 128;

interface MessageRow extends Record<string, SqlStorageValue> {
  sequence: number;
  payload: ArrayBuffer;
  expires_at_ms: number;
}

interface StateRow extends Record<string, SqlStorageValue> {
  next_sequence: number;
  acked_sequence: number;
}

interface InFlightMessage {
  readonly sequence: number;
  readonly expiresAtMs: number;
}

interface SocketAttachment {
  deliveredThrough: number;
  generation: string;
  inFlight: readonly InFlightMessage[];
}

interface PushEvent {
  readonly eventId: string;
  readonly recipientDeviceId: string;
  readonly notificationHint: number;
}

export class RelayMailbox extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS mailbox_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          next_sequence INTEGER NOT NULL,
          acked_sequence INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO mailbox_state (id, next_sequence, acked_sequence) VALUES (1, 1, 0);
        CREATE TABLE IF NOT EXISTS message (
          server_sequence INTEGER PRIMARY KEY,
          sender_device_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          payload BLOB NOT NULL,
          UNIQUE (sender_device_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS message_expiry ON message (expires_at_ms);
        CREATE TABLE IF NOT EXISTS snapshot (
          snapshot_id TEXT PRIMARY KEY,
          covers_through_sequence INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          object_key TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS snapshot_latest ON snapshot (created_at_ms DESC);
        CREATE TABLE IF NOT EXISTS push_outbox (
          event_id TEXT PRIMARY KEY,
          server_sequence INTEGER NOT NULL,
          recipient_device_id TEXT NOT NULL,
          notification_hint INTEGER NOT NULL,
          sent INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS push_registration (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          expo_push_token TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_delivery (
          event_id TEXT PRIMARY KEY,
          delivered_at_ms INTEGER,
          lease_expires_at_ms INTEGER NOT NULL
        );
      `);
    });
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/publish" && request.method === "POST") return this.publish(request);
    if (url.pathname === "/ack" && request.method === "POST") return this.acknowledge(request);
    if (url.pathname === "/snapshot" && request.method === "PUT") return this.putSnapshot(request);
    if (url.pathname === "/snapshot" && request.method === "POST") return this.getSnapshot(request);
    if (url.pathname === "/subscribe" && request.headers.get("upgrade") === "websocket")
      return this.subscribe(url);
    if (url.pathname === "/diagnostics" && request.method === "GET")
      return Response.json(this.diagnostics());
    if (url.pathname === "/push-registration" && request.method === "PUT")
      return this.registerPushToken(request);
    if (url.pathname === "/push-claim" && request.method === "POST") return this.claimPush(request);
    if (url.pathname === "/push-complete" && request.method === "POST")
      return this.completePush(request);
    return new Response("Not found", { status: 404 });
  }

  public override async alarm(): Promise<void> {
    const now = Date.now();
    const expiredSnapshots = this.ctx.storage.sql
      .exec<{ object_key: string }>("SELECT object_key FROM snapshot WHERE expires_at_ms <= ?", now)
      .toArray();
    await Promise.all(
      expiredSnapshots.map((snapshot) => this.env.SNAPSHOTS.delete(snapshot.object_key)),
    );
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM message WHERE expires_at_ms <= ?", now);
      this.ctx.storage.sql.exec(
        "DELETE FROM push_delivery WHERE delivered_at_ms IS NOT NULL AND delivered_at_ms <= ?",
        now - 7 * 24 * 60 * 60 * 1_000,
      );
      this.ctx.storage.sql.exec("DELETE FROM snapshot WHERE expires_at_ms <= ?", now);
    });
    for (const socket of this.ctx.getWebSockets("relay")) this.sendPending(socket);
    const pending = this.ctx.storage.sql
      .exec<{
        event_id: string;
        recipient_device_id: string;
        notification_hint: number;
      }>(
        "SELECT event_id, recipient_device_id, notification_hint FROM push_outbox WHERE sent = 0 ORDER BY server_sequence LIMIT 100",
      )
      .toArray();
    await Promise.all(
      pending.map(async (event) => {
        await this.env.PUSH_QUEUE.send({
          eventId: event.event_id,
          recipientDeviceId: event.recipient_device_id,
          notificationHint: event.notification_hint,
        } satisfies PushEvent);
        this.ctx.storage.sql.exec(
          "UPDATE push_outbox SET sent = 1 WHERE event_id = ?",
          event.event_id,
        );
      }),
    );
    await this.scheduleNextAlarm(true);
  }

  private async publish(request: Request): Promise<Response> {
    const body = fromBinary(PublishRequestSchema, new Uint8Array(await request.arrayBuffer()));
    if (body.envelopes.length === 0 || body.envelopes.length > MAX_ENVELOPES)
      return protobufError("BATCH_SIZE", "Envelope batch must contain 1-64 items", 400);
    const recipient = body.envelopes[0]?.recipientDeviceId;
    if (
      recipient === undefined ||
      body.envelopes.some((item) => item.recipientDeviceId !== recipient)
    )
      return protobufError("MIXED_RECIPIENTS", "A mailbox request must contain one recipient", 400);
    const totalBytes = body.envelopes.reduce((sum, item) => sum + item.ciphertext.byteLength, 0);
    if (totalBytes > MAX_BATCH_BYTES)
      return protobufError("BATCH_SIZE", "Envelope batch exceeds the byte limit", 400);

    const accepted = new Map<string, { sequence: number; duplicate: boolean }>();
    const rejected = new Map<string, { code: string; message: string }>();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const envelope of body.envelopes) {
        const validation = validateEnvelope(envelope, now);
        if (validation !== undefined) {
          rejected.set(envelope.messageId, validation);
          continue;
        }
        const encoded = toBinary(OutboundEnvelopeSchema, envelope);
        const existing = this.ctx.storage.sql
          .exec<MessageRow>(
            "SELECT server_sequence AS sequence, payload FROM message WHERE sender_device_id = ? AND message_id = ?",
            envelope.senderDeviceId,
            envelope.messageId,
          )
          .toArray()[0];
        if (existing !== undefined) {
          if (equalBytes(new Uint8Array(existing.payload), encoded))
            accepted.set(envelope.messageId, { sequence: existing.sequence, duplicate: true });
          else
            rejected.set(envelope.messageId, {
              code: "IDEMPOTENCY_CONFLICT",
              message: "Message ID was already used with different content",
            });
          continue;
        }
        const state = this.state();
        const sequence = state.next_sequence;
        this.ctx.storage.sql.exec(
          "INSERT INTO message (server_sequence, sender_device_id, message_id, expires_at_ms, payload) VALUES (?, ?, ?, ?, ?)",
          sequence,
          envelope.senderDeviceId,
          envelope.messageId,
          safeNumber(envelope.expiresAtMs, "expires_at_ms"),
          arrayBuffer(encoded),
        );
        this.ctx.storage.sql.exec(
          "UPDATE mailbox_state SET next_sequence = ? WHERE id = 1",
          sequence + 1,
        );
        if (envelope.notificationHint >= NotificationHint.WAKE) {
          this.ctx.storage.sql.exec(
            "INSERT INTO push_outbox (event_id, server_sequence, recipient_device_id, notification_hint) VALUES (?, ?, ?, ?)",
            `${envelope.senderDeviceId}:${envelope.messageId}`,
            sequence,
            envelope.recipientDeviceId,
            envelope.notificationHint,
          );
        }
        accepted.set(envelope.messageId, { sequence, duplicate: false });
      }
    });

    if (
      body.envelopes.some((envelope) => {
        const outcome = accepted.get(envelope.messageId);
        return outcome !== undefined && !outcome.duplicate;
      })
    )
      this.broadcast();
    await this.scheduleNextAlarm();

    const results = body.envelopes.map((envelope) => {
      const outcome = accepted.get(envelope.messageId);
      return create(PublishResultSchema, {
        messageId: envelope.messageId,
        outcome:
          outcome === undefined
            ? {
                case: "rejected",
                value: create(RejectedSchema, rejected.get(envelope.messageId)),
              }
            : {
                case: "accepted",
                value: create(AcceptedSchema, {
                  serverSequence: BigInt(outcome.sequence),
                  duplicate: outcome.duplicate,
                }),
              },
      });
    });
    return binaryResponse(
      PublishResponseSchema,
      create(PublishResponseSchema, {
        results,
        acceptedAckServerSequence: BigInt(this.state().acked_sequence),
      }),
    );
  }

  private async acknowledge(request: Request): Promise<Response> {
    const body = fromBinary(AckRequestSchema, new Uint8Array(await request.arrayBuffer()));
    const requested = safeNumber(body.serverSequence, "server_sequence");
    const state = this.state();
    if (requested < state.acked_sequence)
      return protobufError("ACK_REGRESSION", "Acknowledgement cannot move backwards", 409);
    if (requested >= state.next_sequence)
      return protobufError("ACK_BEYOND_ISSUED", "Acknowledgement exceeds the issued sequence", 400);
    this.ctx.storage.sql.exec(
      "UPDATE mailbox_state SET acked_sequence = ? WHERE id = 1",
      requested,
    );
    for (const socket of this.ctx.getWebSockets("relay")) this.sendPending(socket);
    return binaryResponse(
      AckResponseSchema,
      create(AckResponseSchema, { acceptedServerSequence: BigInt(requested) }),
    );
  }

  private async putSnapshot(request: Request): Promise<Response> {
    const body = fromBinary(PutSnapshotRequestSchema, new Uint8Array(await request.arrayBuffer()));
    const snapshot = body.snapshot;
    if (
      snapshot === undefined ||
      snapshot.nonce.byteLength !== 24 ||
      snapshot.ciphertext.byteLength === 0 ||
      snapshot.ciphertext.byteLength > MAX_SNAPSHOT_BYTES
    )
      return protobufError("INVALID_SNAPSHOT", "Snapshot is invalid", 400);
    const encoded = toBinary(EncryptedSnapshotSchema, snapshot);
    const objectKey = snapshotObjectKey(snapshot.recipientDeviceId, snapshot.snapshotId);
    await this.env.SNAPSHOTS.put(objectKey, encoded, {
      httpMetadata: { contentType: "application/protobuf" },
      customMetadata: {
        recipientDeviceId: snapshot.recipientDeviceId,
        snapshotId: snapshot.snapshotId,
      },
    });
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO snapshot (snapshot_id, covers_through_sequence, created_at_ms, expires_at_ms, object_key) VALUES (?, ?, ?, ?, ?)",
      snapshot.snapshotId,
      safeNumber(snapshot.coversThroughSequence, "covers_through_sequence"),
      safeNumber(snapshot.createdAtMs, "created_at_ms"),
      safeNumber(snapshot.expiresAtMs, "expires_at_ms"),
      objectKey,
    );
    await this.scheduleNextAlarm();
    return binaryResponse(
      PutSnapshotResponseSchema,
      create(PutSnapshotResponseSchema, { snapshotId: snapshot.snapshotId }),
    );
  }

  private async getSnapshot(request: Request): Promise<Response> {
    const body = fromBinary(GetSnapshotRequestSchema, new Uint8Array(await request.arrayBuffer()));
    const rows =
      body.snapshotId === undefined
        ? this.ctx.storage.sql
            .exec<{ object_key: string }>(
              "SELECT object_key FROM snapshot WHERE expires_at_ms > ? ORDER BY created_at_ms DESC LIMIT 1",
              Date.now(),
            )
            .toArray()
        : this.ctx.storage.sql
            .exec<{ object_key: string }>(
              "SELECT object_key FROM snapshot WHERE snapshot_id = ? AND expires_at_ms > ? LIMIT 1",
              body.snapshotId,
              Date.now(),
            )
            .toArray();
    const row = rows[0];
    if (row === undefined)
      return binaryResponse(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema));
    const object = await this.env.SNAPSHOTS.get(row.object_key);
    if (object === null)
      return protobufError("SNAPSHOT_UNAVAILABLE", "Snapshot payload is unavailable", 503);
    return binaryResponse(
      GetSnapshotResponseSchema,
      create(GetSnapshotResponseSchema, {
        snapshot: fromBinary(EncryptedSnapshotSchema, new Uint8Array(await object.arrayBuffer())),
      }),
    );
  }

  private subscribe(url: URL): Response {
    const after = parseSequence(url.searchParams.get("after") ?? "0");
    const generation = url.searchParams.get("generation") ?? crypto.randomUUID();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["relay"]);
    server.serializeAttachment({
      deliveredThrough: after,
      generation,
      inFlight: [],
    } satisfies SocketAttachment);
    this.sendPending(server);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "sec-websocket-protocol": "pocket-omp-relay" },
    });
  }

  private sendPending(socket: WebSocket): void {
    const rawAttachment: unknown = socket.deserializeAttachment();
    const attachment = socketAttachment(rawAttachment);
    const state = this.state();
    const now = Date.now();
    const deliveredThrough = attachment?.deliveredThrough ?? state.acked_sequence;
    const inFlight = (attachment?.inFlight ?? []).filter(
      (message) => message.sequence > state.acked_sequence && message.expiresAtMs > now,
    );
    const capacity = MAX_IN_FLIGHT - inFlight.length;
    const rows =
      capacity === 0
        ? []
        : this.ctx.storage.sql
            .exec<MessageRow>(
              "SELECT server_sequence AS sequence, payload, expires_at_ms FROM message WHERE server_sequence > ? AND expires_at_ms > ? ORDER BY server_sequence LIMIT ?",
              deliveredThrough,
              now,
              capacity,
            )
            .toArray();
    let latest = deliveredThrough;
    for (const row of rows) {
      const envelope = fromBinary(OutboundEnvelopeSchema, new Uint8Array(row.payload));
      socket.send(toBinary(RelayFrameSchema, relayEnvelopeFrame(row.sequence, envelope)));
      inFlight.push({ sequence: row.sequence, expiresAtMs: row.expires_at_ms });
      latest = row.sequence;
    }
    socket.serializeAttachment({
      deliveredThrough: latest,
      generation: attachment?.generation ?? crypto.randomUUID(),
      inFlight,
    } satisfies SocketAttachment);
  }

  private broadcast(): void {
    for (const socket of this.ctx.getWebSockets("relay")) this.sendPending(socket);
  }

  private diagnostics(): Record<string, number> {
    const state = this.state();
    const messageCount = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM message")
      .one().count;
    const now = Date.now();
    const queuedMessageCount = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM message WHERE server_sequence > ? AND expires_at_ms > ?",
        state.acked_sequence,
        now,
      )
      .one().count;
    const queueBytes =
      this.ctx.storage.sql
        .exec<{ bytes: number | null }>(
          "SELECT SUM(LENGTH(payload)) AS bytes FROM message WHERE server_sequence > ? AND expires_at_ms > ?",
          state.acked_sequence,
          now,
        )
        .one().bytes ?? 0;
    const snapshotCount = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM snapshot")
      .one().count;
    const pendingPushCount = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM push_outbox WHERE sent = 0")
      .one().count;
    const ackLag = Math.max(0, state.next_sequence - 1 - state.acked_sequence);
    return {
      nextServerSequence: state.next_sequence,
      acknowledgedServerSequence: state.acked_sequence,
      messageCount,
      queuedMessageCount,
      queueBytes,
      ackLag,
      snapshotCount,
      pendingPushCount,
    };
  }

  private async registerPushToken(request: Request): Promise<Response> {
    const value: unknown = await request.json();
    if (
      !isRecord(value) ||
      typeof value.expoPushToken !== "string" ||
      value.expoPushToken.length < 8
    )
      return Response.json({ code: "INVALID_PUSH_TOKEN" }, { status: 400 });
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO push_registration (id, expo_push_token) VALUES (1, ?)",
      value.expoPushToken,
    );
    return new Response(null, { status: 204 });
  }

  private async claimPush(request: Request): Promise<Response> {
    const value: unknown = await request.json();
    if (!isRecord(value) || typeof value.eventId !== "string")
      return Response.json({ code: "INVALID_EVENT" }, { status: 400 });
    const now = Date.now();
    const delivery = this.ctx.storage.sql
      .exec<{ delivered_at_ms: number | null; lease_expires_at_ms: number }>(
        "SELECT delivered_at_ms, lease_expires_at_ms FROM push_delivery WHERE event_id = ?",
        value.eventId,
      )
      .toArray()[0];
    if (delivery?.delivered_at_ms !== null && delivery?.delivered_at_ms !== undefined)
      return Response.json({ status: "duplicate" });
    if (delivery !== undefined && delivery.lease_expires_at_ms > now)
      return Response.json({ status: "busy" });
    const registration = this.ctx.storage.sql
      .exec<{ expo_push_token: string }>(
        "SELECT expo_push_token FROM push_registration WHERE id = 1",
      )
      .toArray()[0];
    if (registration === undefined) return Response.json({ status: "unregistered" });
    this.ctx.storage.sql.exec(
      "INSERT INTO push_delivery (event_id, delivered_at_ms, lease_expires_at_ms) VALUES (?, NULL, ?) ON CONFLICT (event_id) DO UPDATE SET lease_expires_at_ms = excluded.lease_expires_at_ms WHERE push_delivery.delivered_at_ms IS NULL",
      value.eventId,
      now + 60_000,
    );
    return Response.json({ status: "ready", expoPushToken: registration.expo_push_token });
  }

  private async completePush(request: Request): Promise<Response> {
    const value: unknown = await request.json();
    if (!isRecord(value) || typeof value.eventId !== "string")
      return Response.json({ code: "INVALID_EVENT" }, { status: 400 });
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO push_delivery (event_id, delivered_at_ms, lease_expires_at_ms) VALUES (?, ?, 0) ON CONFLICT (event_id) DO UPDATE SET delivered_at_ms = excluded.delivered_at_ms, lease_expires_at_ms = 0",
        value.eventId,
        Date.now(),
      );
      this.ctx.storage.sql.exec("DELETE FROM push_outbox WHERE event_id = ?", value.eventId);
    });
    return new Response(null, { status: 204 });
  }

  private async scheduleNextAlarm(force = false): Promise<void> {
    const nextExpiry = this.ctx.storage.sql
      .exec<{ expires_at_ms: number | null }>(
        "SELECT MIN(expires_at_ms) AS expires_at_ms FROM (SELECT expires_at_ms FROM message UNION ALL SELECT expires_at_ms FROM snapshot)",
      )
      .one().expires_at_ms;
    const hasOutbox =
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM push_outbox WHERE sent = 0")
        .one().count > 0;
    const now = Date.now();
    const desired = hasOutbox
      ? now + 100
      : nextExpiry === null
        ? undefined
        : Math.max(now + 1_000, nextExpiry);
    if (desired === undefined) {
      if (force) await this.ctx.storage.deleteAlarm();
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (force || current === null || desired < current) await this.ctx.storage.setAlarm(desired);
  }

  private state(): StateRow {
    return this.ctx.storage.sql
      .exec<StateRow>("SELECT next_sequence, acked_sequence FROM mailbox_state WHERE id = 1")
      .one();
  }
}

function relayEnvelopeFrame(sequence: number, envelope: OutboundEnvelope) {
  return create(RelayFrameSchema, {
    body: {
      case: "envelope",
      value: create(DeliveredEnvelopeSchema, {
        serverSequence: BigInt(sequence),
        envelope: create(SealedEnvelopeSchema, {
          messageId: envelope.messageId,
          routeId: envelope.routeId,
          senderDeviceId: envelope.senderDeviceId,
          recipientDeviceId: envelope.recipientDeviceId,
          clientSequence: envelope.clientSequence,
          createdAtMs: envelope.createdAtMs,
          expiresAtMs: envelope.expiresAtMs,
          keyId: envelope.keyId,
          nonce: envelope.nonce,
          ciphertext: envelope.ciphertext,
          priority: envelope.priority,
          notificationHint: envelope.notificationHint,
        }),
      }),
    },
  });
}

function validateEnvelope(
  envelope: OutboundEnvelope,
  now: number,
): { code: string; message: string } | undefined {
  if (
    !identifier(envelope.messageId) ||
    !identifier(envelope.routeId) ||
    !identifier(envelope.senderDeviceId) ||
    !identifier(envelope.recipientDeviceId) ||
    !identifier(envelope.keyId) ||
    envelope.senderDeviceId === envelope.recipientDeviceId
  )
    return { code: "INVALID_ARGUMENT", message: "Envelope identifiers are invalid" };
  if (envelope.nonce.byteLength !== 24)
    return { code: "INVALID_NONCE", message: "Envelope nonce must contain 24 bytes" };
  if (envelope.ciphertext.byteLength === 0 || envelope.ciphertext.byteLength > MAX_ENVELOPE_BYTES)
    return { code: "FRAME_TOO_LARGE", message: "Envelope ciphertext is outside the byte limit" };
  const created = safeNumber(envelope.createdAtMs, "created_at_ms");
  const expires = safeNumber(envelope.expiresAtMs, "expires_at_ms");
  const ttl = expires - created;
  if (created > now + 60_000 || expires <= now || ttl < MIN_TTL_MS || ttl > MAX_TTL_MS)
    return { code: "INVALID_EXPIRY", message: "Envelope expiry is outside the accepted range" };
  return undefined;
}

function identifier(value: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(value);
}

function safeNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError(`${field} exceeds the supported range`);
  return number;
}

function snapshotObjectKey(recipientDeviceId: string, snapshotId: string): string {
  return `snapshots/${encodeURIComponent(recipientDeviceId)}/${encodeURIComponent(snapshotId)}.pb`;
}

function socketAttachment(value: unknown): SocketAttachment | undefined {
  if (
    !isRecord(value) ||
    typeof value.deliveredThrough !== "number" ||
    !Number.isSafeInteger(value.deliveredThrough) ||
    typeof value.generation !== "string" ||
    !Array.isArray(value.inFlight)
  )
    return undefined;
  const inFlight: InFlightMessage[] = [];
  for (const message of value.inFlight) {
    if (
      !isRecord(message) ||
      typeof message.sequence !== "number" ||
      !Number.isSafeInteger(message.sequence) ||
      typeof message.expiresAtMs !== "number" ||
      !Number.isSafeInteger(message.expiresAtMs)
    )
      return undefined;
    inFlight.push({ sequence: message.sequence, expiresAtMs: message.expiresAtMs });
  }
  return { deliveredThrough: value.deliveredThrough, generation: value.generation, inFlight };
}

function parseSequence(value: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new RangeError("Invalid server sequence");
  return sequence;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function binaryResponse<Desc extends DescMessage>(
  schema: Desc,
  value: MessageShape<Desc>,
): Response {
  return new Response(toBinary(schema, value), {
    headers: { "content-type": "application/protobuf", "cache-control": "no-store" },
  });
}

function protobufError(code: string, message: string, status: number): Response {
  return Response.json({ code, message }, { status, headers: { "cache-control": "no-store" } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type { PushEvent };

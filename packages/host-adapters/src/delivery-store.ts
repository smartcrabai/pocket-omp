// bun:sqlite-backed HostDeliveryStore (ADR-006 delivery idempotency,
// ADR-014 snapshot/cursor replay). The database path is injectable so tests
// can use ":memory:"; schema creation is idempotent so repeated process
// starts against the same on-disk file are safe.

import { Database, SQLiteError } from "bun:sqlite";
import type { HostDeliveryStore, HostInboundEnvelope, HostOutboxItem } from "@pocket-omp/host-core";

const DEFAULT_PATH = ":memory:";
const MAX_LIMIT = 1_000;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS host_relay_outbox (
    message_id TEXT PRIMARY KEY,
    encrypted TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS host_relay_inbound (
    message_id TEXT PRIMARY KEY,
    server_sequence INTEGER NOT NULL,
    encrypted TEXT NOT NULL,
    handled INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS host_relay_inbound_pending
    ON host_relay_inbound (server_sequence) WHERE handled = 0;
  CREATE TABLE IF NOT EXISTS host_relay_cursor (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    server_sequence INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO host_relay_cursor (id, server_sequence) VALUES (1, 0);
`;

interface OutboxRow {
  readonly message_id: string;
  readonly encrypted: string;
}

interface InboundRow {
  readonly message_id: string;
  readonly server_sequence: bigint;
  readonly encrypted: string;
}

interface CursorRow {
  readonly server_sequence: bigint;
}

/**
 * The `encrypted` payload handed to this store by HostRelayCoordinator is
 * declared `unknown` by the host-core contract (HostOutboxItem /
 * HostInboundEnvelope); this store never interprets it; it only persists and
 * returns it byte-for-byte. It is stored as a small self-describing JSON
 * encoding (see encodeOpaque/decodeOpaque below) that round-trips the
 * bigint/Uint8Array/string/number fields a sealed relay envelope is made of,
 * without this store needing any knowledge of the relay proto shapes.
 */
export class HostSqliteDeliveryStore implements HostDeliveryStore {
  private readonly db: Database;

  public constructor(path: string = DEFAULT_PATH) {
    this.db = new Database(path, { create: true, readwrite: true, safeIntegers: true });
    this.db.run(SCHEMA_SQL);
  }

  public close(): void {
    this.db.close();
  }

  public async relayCursor(): Promise<bigint> {
    const row = this.db
      .query<CursorRow, []>("SELECT server_sequence FROM host_relay_cursor WHERE id = 1")
      .get();
    if (row === null) {
      throw new HostDeliveryStoreError("CORRUPT_STATE", "Relay cursor row is missing");
    }
    return row.server_sequence;
  }

  public async appendOutbox(item: HostOutboxItem): Promise<boolean> {
    requireMessageId(item.messageId);
    try {
      this.db.run("INSERT INTO host_relay_outbox (message_id, encrypted) VALUES (?, ?)", [
        item.messageId,
        encodeOpaque(item.encrypted),
      ]);
      return true;
    } catch (error) {
      if (isConstraintViolation(error)) return false;
      throw error;
    }
  }

  public async pendingOutbox(limit: number): Promise<readonly HostOutboxItem[]> {
    validateLimit(limit);
    const rows = this.db
      .query<OutboxRow, [number]>(
        "SELECT message_id, encrypted FROM host_relay_outbox ORDER BY rowid ASC LIMIT ?",
      )
      .all(limit);
    return rows.map((row) => ({
      messageId: row.message_id,
      encrypted: decodeOpaque(row.encrypted),
    }));
  }

  public async markOutboxPublished(messageIds: readonly string[]): Promise<void> {
    for (const messageId of messageIds) {
      this.db.run("DELETE FROM host_relay_outbox WHERE message_id = ?", [messageId]);
    }
  }

  public async persistInbound(envelope: HostInboundEnvelope): Promise<boolean> {
    requireMessageId(envelope.messageId);
    if (envelope.serverSequence <= 0n) {
      throw new HostDeliveryStoreError("INVALID_SEQUENCE", "serverSequence must be positive");
    }
    try {
      this.db.run(
        "INSERT INTO host_relay_inbound (message_id, server_sequence, encrypted, handled) VALUES (?, ?, ?, 0)",
        [envelope.messageId, envelope.serverSequence, encodeOpaque(envelope.encrypted)],
      );
      return true;
    } catch (error) {
      if (isConstraintViolation(error)) return false;
      throw error;
    }
  }

  public async pendingInbound(limit: number): Promise<readonly HostInboundEnvelope[]> {
    validateLimit(limit);
    const rows = this.db
      .query<InboundRow, [number]>(
        "SELECT message_id, server_sequence, encrypted FROM host_relay_inbound WHERE handled = 0 ORDER BY server_sequence ASC LIMIT ?",
      )
      .all(limit);
    return rows.map((row) => ({
      messageId: row.message_id,
      serverSequence: row.server_sequence,
      encrypted: decodeOpaque(row.encrypted),
    }));
  }

  public async markInboundHandled(messageId: string): Promise<void> {
    this.db.run("UPDATE host_relay_inbound SET handled = 1 WHERE message_id = ?", [messageId]);
  }

  public async advanceRelayCursor(serverSequence: bigint): Promise<void> {
    this.db.run(
      "UPDATE host_relay_cursor SET server_sequence = MAX(server_sequence, ?) WHERE id = 1",
      [serverSequence],
    );
  }
}

function requireMessageId(messageId: string): void {
  if (messageId.length === 0) {
    throw new HostDeliveryStoreError("INVALID_MESSAGE_ID", "messageId must not be empty");
  }
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new HostDeliveryStoreError(
      "INVALID_LIMIT",
      `limit must be a positive integer no greater than ${MAX_LIMIT}`,
    );
  }
}

function isConstraintViolation(error: unknown): boolean {
  return error instanceof SQLiteError && (error.code?.startsWith("SQLITE_CONSTRAINT") ?? false);
}

function encodeOpaque(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    throw new HostDeliveryStoreError("INVALID_ENVELOPE", "Envelope payload must be an object");
  }
  return JSON.stringify(value, opaqueReplacer);
}

function decodeOpaque(text: string): unknown {
  return JSON.parse(text, opaqueReviver);
}

function opaqueReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { $opaqueType: "bigint", value: value.toString() };
  if (value instanceof Uint8Array) {
    return { $opaqueType: "bytes", value: Buffer.from(value).toString("base64") };
  }
  return value;
}

function opaqueReviver(_key: string, value: unknown): unknown {
  if (isOpaqueTag(value, "bigint")) return BigInt(value.value);
  if (isOpaqueTag(value, "bytes")) return new Uint8Array(Buffer.from(value.value, "base64"));
  return value;
}

function isOpaqueTag(
  value: unknown,
  tag: "bigint" | "bytes",
): value is { readonly $opaqueType: string; readonly value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "$opaqueType" in value &&
    value.$opaqueType === tag &&
    "value" in value &&
    typeof value.value === "string"
  );
}

export class HostDeliveryStoreError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_MESSAGE_ID"
      | "INVALID_SEQUENCE"
      | "INVALID_LIMIT"
      | "INVALID_ENVELOPE"
      | "CORRUPT_STATE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostDeliveryStoreError";
  }
}

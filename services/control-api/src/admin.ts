import { DurableObject } from "cloudflare:workers";
import {
  AdminApplication,
  type AdminAuditRepository,
  type AdminAuthorizationRepository,
  type AdminPrincipal,
  type AdminRole,
  type Account,
  type AccountId,
  type AccountRepository,
  type Clock,
  ControlInvariantError,
  type Device,
  type DeviceId,
  type DeviceRepository,
  type EntitlementRepository,
  type EntitlementState,
  type IdGenerator,
  type RelayDiagnosticsReader,
  type SubscriptionEvent,
  type VerifiedIdentity,
  accountId,
  deviceId,
} from "@pocket-omp/control-core";

interface AccountRow extends Record<string, SqlStorageValue> {
  account_id: string;
  status: Account["status"];
  created_at_ms: number;
}

interface DeviceRow extends Record<string, SqlStorageValue> {
  device_id: string;
  account_id: string;
  kind: Device["kind"];
  name: string;
  public_key: ArrayBuffer;
  credential_generation: number;
  revoked_at_ms: number | null;
  last_seen_at_ms: number;
}

interface EntitlementRow extends Record<string, SqlStorageValue> {
  state: string;
  usable_until_ms: number | null;
  last_occurred_at_ms: number;
}

export interface AdminSeedFixture {
  readonly account: Account;
  readonly devices: readonly Device[];
  readonly entitlement?: EntitlementState;
  readonly grants: readonly {
    staffSubject: string;
    grantId: string;
    roles: readonly AdminRole[];
    expiresAtMs: bigint;
  }[];
}

export class AdminControl extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS account (
          account_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS identity (
          provider TEXT NOT NULL,
          subject TEXT NOT NULL,
          account_id TEXT NOT NULL,
          email TEXT,
          PRIMARY KEY (provider, subject)
        );
        CREATE TABLE IF NOT EXISTS device (
          device_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          public_key BLOB NOT NULL,
          credential_generation INTEGER NOT NULL,
          revoked_at_ms INTEGER,
          last_seen_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS device_account ON device (account_id);
        CREATE TABLE IF NOT EXISTS entitlement (
          account_id TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          usable_until_ms INTEGER,
          last_occurred_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS admin_grant (
          staff_subject TEXT NOT NULL,
          account_id TEXT NOT NULL,
          grant_id TEXT NOT NULL,
          role TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          PRIMARY KEY (staff_subject, account_id, grant_id, role)
        );
        CREATE TABLE IF NOT EXISTS admin_audit (
          event_id TEXT PRIMARY KEY,
          staff_subject TEXT NOT NULL,
          action TEXT NOT NULL,
          account_id TEXT,
          target_id TEXT,
          correlation_id TEXT NOT NULL,
          metadata TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reconciliation_job (
          job_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          status TEXT NOT NULL
        );
      `);
    });
  }

  public seedFixture(fixture: AdminSeedFixture): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO account (account_id, status, created_at_ms) VALUES (?, ?, ?)",
        fixture.account.accountId,
        fixture.account.status,
        safeNumber(fixture.account.createdAtMs),
      );
      for (const device of fixture.devices) this.insertDevice(device);
      if (fixture.entitlement !== undefined)
        this.saveEntitlement(fixture.account.accountId, fixture.entitlement, 0n);
      for (const grant of fixture.grants)
        for (const role of grant.roles)
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO admin_grant (staff_subject, account_id, grant_id, role, expires_at_ms) VALUES (?, ?, ?, ?, ?)",
            grant.staffSubject,
            fixture.account.accountId,
            grant.grantId,
            role,
            safeNumber(grant.expiresAtMs),
          );
    });
  }

  public findOrCreateAccount(identity: VerifiedIdentity, id: AccountId, nowMs: bigint): Account {
    const existingIdentity = this.ctx.storage.sql
      .exec<{ account_id: string }>(
        "SELECT account_id FROM identity WHERE provider = ? AND subject = ?",
        identity.provider,
        identity.subject,
      )
      .toArray()[0];
    if (existingIdentity !== undefined) {
      const existing = this.getAccount(accountId(existingIdentity.account_id));
      if (existing === undefined) throw new ControlInvariantError("Identity account is missing");
      return existing;
    }
    const account: Account = { accountId: id, status: "active", createdAtMs: nowMs };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO account (account_id, status, created_at_ms) VALUES (?, ?, ?)",
        id,
        account.status,
        safeNumber(nowMs),
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO identity (provider, subject, account_id, email) VALUES (?, ?, ?, ?)",
        identity.provider,
        identity.subject,
        id,
        identity.email ?? null,
      );
    });
    return account;
  }

  public getAccount(id: AccountId): Account | undefined {
    const row = this.ctx.storage.sql
      .exec<AccountRow>(
        "SELECT account_id, status, created_at_ms FROM account WHERE account_id = ?",
        id,
      )
      .toArray()[0];
    return row === undefined
      ? undefined
      : {
          accountId: accountId(row.account_id),
          status: row.status,
          createdAtMs: BigInt(row.created_at_ms),
        };
  }

  public createDevice(device: Device): void {
    this.insertDevice(device);
  }

  public getDevice(id: DeviceId): Device | undefined {
    const row = this.ctx.storage.sql
      .exec<DeviceRow>("SELECT * FROM device WHERE device_id = ?", id)
      .toArray()[0];
    return row === undefined ? undefined : deviceFromRow(row);
  }

  public listDevices(id: AccountId): readonly Device[] {
    return this.ctx.storage.sql
      .exec<DeviceRow>("SELECT * FROM device WHERE account_id = ? ORDER BY device_id", id)
      .toArray()
      .map(deviceFromRow);
  }

  public revokeDevice(account: AccountId, device: DeviceId, nowMs: bigint): bigint {
    const row = this.ctx.storage.sql
      .exec<{ credential_generation: number }>(
        "UPDATE device SET revoked_at_ms = ?, credential_generation = credential_generation + 1 WHERE account_id = ? AND device_id = ? RETURNING credential_generation",
        safeNumber(nowMs),
        account,
        device,
      )
      .toArray()[0];
    if (row === undefined) throw new ControlInvariantError("Device not found");
    return BigInt(row.credential_generation);
  }

  public getEntitlement(id: AccountId): EntitlementState | undefined {
    const row = this.ctx.storage.sql
      .exec<EntitlementRow>(
        "SELECT state, usable_until_ms, last_occurred_at_ms FROM entitlement WHERE account_id = ?",
        id,
      )
      .toArray()[0];
    return row === undefined ? undefined : entitlementFromRow(row);
  }

  public applyEntitlementEvent(id: AccountId, event: SubscriptionEvent): boolean {
    const current = this.ctx.storage.sql
      .exec<{ last_occurred_at_ms: number }>(
        "SELECT last_occurred_at_ms FROM entitlement WHERE account_id = ?",
        id,
      )
      .toArray()[0];
    if (current !== undefined && BigInt(current.last_occurred_at_ms) > event.occurredAtMs)
      return false;
    this.saveEntitlement(id, event.state, event.occurredAtMs);
    return true;
  }

  public hasActiveGrant(
    staffSubject: string,
    account: AccountId,
    grantId: string,
    requiredRole: AdminRole,
    nowMs: bigint,
  ): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM admin_grant WHERE staff_subject = ? AND account_id = ? AND grant_id = ? AND role = ? AND expires_at_ms > ?",
          staffSubject,
          account,
          grantId,
          requiredRole,
          safeNumber(nowMs),
        )
        .one().count > 0
    );
  }

  public appendAudit(event: Parameters<AdminAuditRepository["append"]>[0]): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO admin_audit (event_id, staff_subject, action, account_id, target_id, correlation_id, metadata, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      event.eventId,
      event.staffSubject,
      event.action,
      event.accountId ?? null,
      event.targetId ?? null,
      event.correlationId,
      JSON.stringify(event.metadata),
      Date.now(),
    );
  }

  public enqueueReconciliation(account: AccountId, requestedBy: string, jobId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO reconciliation_job (job_id, account_id, requested_by, created_at_ms, status) VALUES (?, ?, ?, ?, 'pending')",
      jobId,
      account,
      requestedBy,
      Date.now(),
    );
  }

  public listAuditActions(): readonly string[] {
    return this.ctx.storage.sql
      .exec<{ action: string }>("SELECT action FROM admin_audit ORDER BY created_at_ms, event_id")
      .toArray()
      .map((row) => row.action);
  }

  private insertDevice(device: Device): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO device (device_id, account_id, kind, name, public_key, credential_generation, revoked_at_ms, last_seen_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      device.deviceId,
      device.accountId,
      device.kind,
      device.name,
      bytesBuffer(device.publicKey),
      safeNumber(device.credentialGeneration),
      device.revokedAtMs === undefined ? null : safeNumber(device.revokedAtMs),
      safeNumber(device.lastSeenAtMs),
    );
  }

  private saveEntitlement(
    account: AccountId,
    state: EntitlementState,
    lastOccurredAtMs: bigint,
  ): void {
    const usableUntilMs = "usableUntilMs" in state ? (state.usableUntilMs ?? null) : null;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO entitlement (account_id, state, usable_until_ms, last_occurred_at_ms) VALUES (?, ?, ?, ?)",
      account,
      state.kind,
      usableUntilMs === null ? null : safeNumber(usableUntilMs),
      safeNumber(lastOccurredAtMs),
    );
  }
}

class CloudflareAccounts implements AccountRepository {
  public constructor(private readonly store: DurableObjectStub<AdminControl>) {}
  public findOrCreate(identity: VerifiedIdentity, id: AccountId, nowMs: bigint): Promise<Account> {
    return this.store.findOrCreateAccount(identity, id, nowMs);
  }
  public get(id: AccountId): Promise<Account | undefined> {
    return this.store.getAccount(id);
  }
}

class CloudflareDevices implements DeviceRepository {
  public constructor(private readonly store: DurableObjectStub<AdminControl>) {}
  public async create(device: Device, _credentialHash: string): Promise<void> {
    await this.store.createDevice(device);
  }
  public get(id: DeviceId): Promise<Device | undefined> {
    return this.store.getDevice(id);
  }
  public list(id: AccountId): Promise<readonly Device[]> {
    return this.store.listDevices(id);
  }
  public revoke(account: AccountId, device: DeviceId, nowMs: bigint): Promise<bigint> {
    return this.store.revokeDevice(account, device, nowMs);
  }
}

class CloudflareEntitlements implements EntitlementRepository {
  public constructor(private readonly store: DurableObjectStub<AdminControl>) {}
  public get(id: AccountId): Promise<EntitlementState | undefined> {
    return this.store.getEntitlement(id);
  }
  public applyEvent(id: AccountId, event: SubscriptionEvent): Promise<boolean> {
    return this.store.applyEntitlementEvent(id, event);
  }
}

class CloudflareAdminSecurity implements AdminAuthorizationRepository, AdminAuditRepository {
  public constructor(private readonly store: DurableObjectStub<AdminControl>) {}
  public hasActiveGrant(
    staffSubject: string,
    account: AccountId,
    grantId: string,
    requiredRole: AdminRole,
    nowMs: bigint,
  ): Promise<boolean> {
    return this.store.hasActiveGrant(staffSubject, account, grantId, requiredRole, nowMs);
  }
  public async append(event: Parameters<AdminAuditRepository["append"]>[0]): Promise<void> {
    await this.store.appendAudit(event);
  }
}

class CloudflareRelayDiagnostics implements RelayDiagnosticsReader {
  public constructor(private readonly env: Env) {}
  public async getDeliveryMetadata(id: DeviceId): Promise<{
    readonly queueCount: bigint;
    readonly queueBytes: bigint;
    readonly ackLag: bigint;
    readonly homeRegion: string;
    readonly routeEpoch: bigint;
  }> {
    const response = await this.env.RELAY_MAILBOX.getByName(id).fetch(
      "https://mailbox.internal/diagnostics",
    );
    const value: unknown = await response.json();
    if (
      !isRecord(value) ||
      typeof value.queuedMessageCount !== "number" ||
      typeof value.queueBytes !== "number" ||
      typeof value.ackLag !== "number"
    )
      throw new ControlInvariantError("Relay diagnostics are unavailable");
    return {
      queueCount: BigInt(value.queuedMessageCount),
      queueBytes: BigInt(value.queueBytes),
      ackLag: BigInt(value.ackLag),
      homeRegion: "cloudflare",
      routeEpoch: 0n,
    };
  }
}

export interface AdminServices {
  readonly application: AdminApplication;
  readonly security: CloudflareAdminSecurity;
  readonly store: DurableObjectStub<AdminControl>;
  readonly diagnostics: CloudflareRelayDiagnostics;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export function createAdminServices(env: Env): AdminServices {
  const store = env.ADMIN_CONTROL.getByName("control");
  const security = new CloudflareAdminSecurity(store);
  const diagnostics = new CloudflareRelayDiagnostics(env);
  const clock: Clock = { nowMs: () => BigInt(Date.now()) };
  const ids: IdGenerator = { newId: () => crypto.randomUUID() };
  return {
    application: new AdminApplication(
      security,
      security,
      new CloudflareAccounts(store),
      new CloudflareDevices(store),
      new CloudflareEntitlements(store),
      diagnostics,
      clock,
      ids,
    ),
    security,
    store,
    diagnostics,
    clock,
    ids,
  };
}

export async function authorizeAdminAction(
  services: AdminServices,
  principal: AdminPrincipal,
  account: AccountId,
  grantId: string,
  requiredRole: AdminRole,
  requireStepUp: boolean,
  correlationId: string,
): Promise<void> {
  const now = services.clock.nowMs();
  const stepUpValid =
    !requireStepUp ||
    (principal.stepUpAtMs !== undefined &&
      principal.stepUpAtMs <= now &&
      now - principal.stepUpAtMs <= 300_000n);
  const allowed =
    principal.roles.has(requiredRole) &&
    stepUpValid &&
    (await services.security.hasActiveGrant(
      principal.staffSubject,
      account,
      grantId,
      requiredRole,
      now,
    ));
  if (allowed) return;
  await services.security.append({
    eventId: services.ids.newId(),
    staffSubject: principal.staffSubject || "unknown",
    action: "AdminAccessDenied",
    accountId: account,
    correlationId,
    metadata: { requiredRole, requireStepUp },
  });
  throw new ControlInvariantError("Admin access denied");
}

function deviceFromRow(row: DeviceRow): Device {
  return {
    deviceId: deviceId(row.device_id),
    accountId: accountId(row.account_id),
    kind: row.kind,
    name: row.name,
    publicKey: new Uint8Array(row.public_key),
    credentialGeneration: BigInt(row.credential_generation),
    ...(row.revoked_at_ms === null ? {} : { revokedAtMs: BigInt(row.revoked_at_ms) }),
    lastSeenAtMs: BigInt(row.last_seen_at_ms),
  };
}

function entitlementFromRow(row: EntitlementRow): EntitlementState {
  const usableUntilMs = row.usable_until_ms === null ? undefined : BigInt(row.usable_until_ms);
  switch (row.state) {
    case "active":
    case "grace-period":
      if (usableUntilMs === undefined) throw new ControlInvariantError("Entitlement is corrupt");
      return { kind: row.state, usableUntilMs };
    case "billing-retry":
      return { kind: row.state, ...(usableUntilMs === undefined ? {} : { usableUntilMs }) };
    case "paused":
    case "expired":
    case "refunded":
    case "revoked":
      return { kind: row.state };
    default:
      throw new ControlInvariantError("Entitlement is corrupt");
  }
}

function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new ControlInvariantError("Integer exceeds SQLite range");
  return number;
}

function bytesBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

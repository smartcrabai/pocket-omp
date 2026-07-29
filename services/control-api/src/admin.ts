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

type PairingState = "awaiting-claim" | "awaiting-confirmations" | "completed" | "expired";

interface PairingRow extends Record<string, SqlStorageValue> {
  pairing_id: string;
  host_name: string;
  host_public_key: ArrayBuffer;
  challenge_hash: ArrayBuffer;
  watch_secret_hash: string;
  state: PairingState;
  account_id: string | null;
  mobile_device_id: string | null;
  mobile_public_key: ArrayBuffer | null;
  host_device_id: string | null;
  route_id: string | null;
  host_confirmed: number;
  mobile_confirmed: number;
  expires_at_ms: number;
  created_at_ms: number;
}

export interface PairingRecord {
  readonly pairingId: string;
  readonly hostName: string;
  readonly hostPublicKey: Uint8Array;
  readonly challengeHash: Uint8Array;
  readonly watchSecretHash: string;
  readonly state: PairingState;
  readonly accountId?: string;
  readonly mobileDeviceId?: string;
  readonly mobilePublicKey?: Uint8Array;
  readonly hostDeviceId?: string;
  readonly routeId?: string;
  readonly hostConfirmed: boolean;
  readonly mobileConfirmed: boolean;
  readonly expiresAtMs: bigint;
  readonly createdAtMs: bigint;
}

interface RouteRow extends Record<string, SqlStorageValue> {
  route_id: string;
  account_id: string;
  host_device_id: string | null;
  mobile_device_id: string;
  home_region: string;
  standby_region: string;
  relay_origin: string;
  route_epoch: number;
  frozen: number;
  created_at_ms: number;
}

export interface RouteRecord {
  readonly routeId: string;
  readonly accountId: string;
  readonly hostDeviceId?: string;
  readonly mobileDeviceId: string;
  readonly homeRegion: string;
  readonly standbyRegion: string;
  readonly relayOrigin: string;
  readonly routeEpoch: bigint;
  readonly frozen: boolean;
  readonly createdAtMs: bigint;
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
          last_seen_at_ms INTEGER NOT NULL,
          credential_hash TEXT
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
        CREATE TABLE IF NOT EXISTS pairing (
          pairing_id TEXT PRIMARY KEY,
          host_name TEXT NOT NULL,
          host_public_key BLOB NOT NULL,
          challenge_hash BLOB NOT NULL,
          watch_secret_hash TEXT NOT NULL,
          state TEXT NOT NULL,
          account_id TEXT,
          mobile_device_id TEXT,
          mobile_public_key BLOB,
          host_device_id TEXT,
          route_id TEXT,
          host_confirmed INTEGER NOT NULL DEFAULT 0,
          mobile_confirmed INTEGER NOT NULL DEFAULT 0,
          expires_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS route (
          route_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          host_device_id TEXT,
          mobile_device_id TEXT NOT NULL,
          home_region TEXT NOT NULL,
          standby_region TEXT NOT NULL,
          relay_origin TEXT NOT NULL,
          route_epoch INTEGER NOT NULL,
          frozen INTEGER NOT NULL DEFAULT 0,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS route_account ON route (account_id);
        CREATE INDEX IF NOT EXISTS route_host_device ON route (host_device_id);
        CREATE INDEX IF NOT EXISTS route_mobile_device ON route (mobile_device_id);
      `);
      // device.credential_hash was added after the initial schema; add it for
      // databases created before the column existed.
      try {
        this.ctx.storage.sql.exec("ALTER TABLE device ADD COLUMN credential_hash TEXT");
      } catch {
        // Column already exists.
      }
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

  public createDevice(device: Device, credentialHash?: string): void {
    this.insertDevice(device, credentialHash);
  }

  public renameDevice(account: AccountId, device: DeviceId, name: string): Device {
    const row = this.ctx.storage.sql
      .exec<DeviceRow>(
        "UPDATE device SET name = ? WHERE account_id = ? AND device_id = ? AND revoked_at_ms IS NULL RETURNING *",
        name,
        account,
        device,
      )
      .toArray()[0];
    if (row === undefined) throw new ControlInvariantError("Device not found");
    return deviceFromRow(row);
  }

  public verifyDeviceCredential(device: DeviceId, credentialHash: string): boolean {
    const row = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM device WHERE device_id = ? AND credential_hash = ? AND revoked_at_ms IS NULL",
        device,
        credentialHash,
      )
      .one();
    return row.count > 0;
  }

  public createPairing(record: PairingRecord): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO pairing (pairing_id, host_name, host_public_key, challenge_hash, watch_secret_hash, state, account_id, mobile_device_id, mobile_public_key, host_device_id, route_id, host_confirmed, mobile_confirmed, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      record.pairingId,
      record.hostName,
      bytesBuffer(record.hostPublicKey),
      bytesBuffer(record.challengeHash),
      record.watchSecretHash,
      record.state,
      record.accountId ?? null,
      record.mobileDeviceId ?? null,
      record.mobilePublicKey === undefined ? null : bytesBuffer(record.mobilePublicKey),
      record.hostDeviceId ?? null,
      record.routeId ?? null,
      record.hostConfirmed ? 1 : 0,
      record.mobileConfirmed ? 1 : 0,
      safeNumber(record.expiresAtMs),
      safeNumber(record.createdAtMs),
    );
  }

  public getPairing(id: string): PairingRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<PairingRow>("SELECT * FROM pairing WHERE pairing_id = ?", id)
      .toArray()[0];
    return row === undefined ? undefined : pairingFromRow(row);
  }

  public savePairing(record: PairingRecord): void {
    this.ctx.storage.sql.exec(
      "UPDATE pairing SET state = ?, account_id = ?, mobile_device_id = ?, mobile_public_key = ?, host_device_id = ?, route_id = ?, host_confirmed = ?, mobile_confirmed = ? WHERE pairing_id = ?",
      record.state,
      record.accountId ?? null,
      record.mobileDeviceId ?? null,
      record.mobilePublicKey === undefined ? null : bytesBuffer(record.mobilePublicKey),
      record.hostDeviceId ?? null,
      record.routeId ?? null,
      record.hostConfirmed ? 1 : 0,
      record.mobileConfirmed ? 1 : 0,
      record.pairingId,
    );
  }

  public claimPairingTx(
    pairingId: string,
    expectedChallengeHash: Uint8Array,
    account: AccountId,
    device: Device,
    credentialHash: string,
    route: RouteRecord,
  ): PairingRecord {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<PairingRow>("SELECT * FROM pairing WHERE pairing_id = ?", pairingId)
        .toArray()[0];
      if (row === undefined) throw new ControlInvariantError("Pairing not found");
      const pairing = pairingFromRow(row);
      if (BigInt(Date.now()) >= pairing.expiresAtMs) {
        this.savePairing({ ...pairing, state: "expired" });
        throw new ControlInvariantError("Pairing has expired");
      }
      if (pairing.state !== "awaiting-claim")
        throw new ControlInvariantError("Pairing is not claimable");
      if (!equalBytes(pairing.challengeHash, expectedChallengeHash))
        throw new ControlInvariantError("Invalid pairing challenge");
      this.insertDevice(device, credentialHash);
      this.createRoute(route);
      const claimed: PairingRecord = {
        ...pairing,
        state: "awaiting-confirmations",
        accountId: account,
        mobileDeviceId: device.deviceId,
        mobilePublicKey: device.publicKey,
        routeId: route.routeId,
      };
      this.savePairing(claimed);
      return claimed;
    });
  }

  public completePairingHostTx(
    pairingId: string,
    watchSecretHash: string,
    device: Device,
    credentialHash: string,
  ): PairingRecord {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<PairingRow>("SELECT * FROM pairing WHERE pairing_id = ?", pairingId)
        .toArray()[0];
      if (row === undefined) throw new ControlInvariantError("Pairing not found");
      const pairing = pairingFromRow(row);
      if (BigInt(Date.now()) >= pairing.expiresAtMs) {
        this.savePairing({ ...pairing, state: "expired" });
        throw new ControlInvariantError("Pairing has expired");
      }
      if (pairing.state !== "awaiting-confirmations")
        throw new ControlInvariantError("Pairing is not awaiting confirmation");
      if (pairing.watchSecretHash !== watchSecretHash)
        throw new ControlInvariantError("Invalid pairing watch secret");
      if (pairing.routeId === undefined) throw new ControlInvariantError("Pairing is not claimed");
      this.insertDevice(device, credentialHash);
      this.attachHostToRoute(pairing.routeId, device.deviceId);
      const confirmed: PairingRecord = {
        ...pairing,
        state: pairing.mobileConfirmed ? "completed" : "awaiting-confirmations",
        hostDeviceId: device.deviceId,
        hostConfirmed: true,
      };
      this.savePairing(confirmed);
      return confirmed;
    });
  }

  public confirmPairingMobileTx(pairingId: string, account: AccountId): PairingRecord {
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<PairingRow>("SELECT * FROM pairing WHERE pairing_id = ?", pairingId)
        .toArray()[0];
      if (row === undefined) throw new ControlInvariantError("Pairing not found");
      const pairing = pairingFromRow(row);
      if (BigInt(Date.now()) >= pairing.expiresAtMs) {
        this.savePairing({ ...pairing, state: "expired" });
        throw new ControlInvariantError("Pairing has expired");
      }
      if (pairing.state !== "awaiting-confirmations")
        throw new ControlInvariantError("Pairing is not awaiting confirmation");
      if (pairing.accountId !== account)
        throw new ControlInvariantError("Pairing belongs to a different account");
      const confirmed: PairingRecord = {
        ...pairing,
        state: pairing.hostConfirmed ? "completed" : "awaiting-confirmations",
        mobileConfirmed: true,
      };
      this.savePairing(confirmed);
      return confirmed;
    });
  }

  public deleteExpiredPairings(nowMs: bigint): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM pairing WHERE state != 'completed' AND expires_at_ms <= ?",
      safeNumber(nowMs),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM pairing WHERE state = 'completed' AND created_at_ms <= ?",
      safeNumber(nowMs - 3_600_000n),
    );
  }

  public createRoute(route: RouteRecord): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO route (route_id, account_id, host_device_id, mobile_device_id, home_region, standby_region, relay_origin, route_epoch, frozen, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      route.routeId,
      route.accountId,
      route.hostDeviceId ?? null,
      route.mobileDeviceId,
      route.homeRegion,
      route.standbyRegion,
      route.relayOrigin,
      safeNumber(route.routeEpoch),
      route.frozen ? 1 : 0,
      safeNumber(route.createdAtMs),
    );
  }

  public getRoute(id: string): RouteRecord | undefined {
    const row = this.ctx.storage.sql
      .exec<RouteRow>("SELECT * FROM route WHERE route_id = ?", id)
      .toArray()[0];
    return row === undefined ? undefined : routeFromRow(row);
  }

  public listRoutesForDevice(account: AccountId, device: DeviceId): readonly RouteRecord[] {
    return this.ctx.storage.sql
      .exec<RouteRow>(
        "SELECT * FROM route WHERE account_id = ? AND (host_device_id = ? OR mobile_device_id = ?)",
        account,
        device,
        device,
      )
      .toArray()
      .map(routeFromRow);
  }

  public attachHostToRoute(routeId: string, hostDeviceId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE route SET host_device_id = ? WHERE route_id = ?",
      hostDeviceId,
      routeId,
    );
  }

  public freezeRoute(routeId: string): void {
    this.ctx.storage.sql.exec("UPDATE route SET frozen = 1 WHERE route_id = ?", routeId);
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
    const row = this.getEntitlementRow(id);
    return row === undefined ? undefined : entitlementFromRow(row);
  }

  public getEntitlementUpdatedAtMs(id: AccountId): bigint | undefined {
    const row = this.getEntitlementRow(id);
    return row === undefined ? undefined : BigInt(row.last_occurred_at_ms);
  }

  private getEntitlementRow(id: AccountId): EntitlementRow | undefined {
    return this.ctx.storage.sql
      .exec<EntitlementRow>(
        "SELECT state, usable_until_ms, last_occurred_at_ms FROM entitlement WHERE account_id = ?",
        id,
      )
      .toArray()[0];
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

  public saveEntitlementState(id: AccountId, state: EntitlementState, occurredAtMs: bigint): void {
    this.saveEntitlement(id, state, occurredAtMs);
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

  private insertDevice(device: Device, credentialHash?: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO device (device_id, account_id, kind, name, public_key, credential_generation, revoked_at_ms, last_seen_at_ms, credential_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      device.deviceId,
      device.accountId,
      device.kind,
      device.name,
      bytesBuffer(device.publicKey),
      safeNumber(device.credentialGeneration),
      device.revokedAtMs === undefined ? null : safeNumber(device.revokedAtMs),
      safeNumber(device.lastSeenAtMs),
      credentialHash ?? null,
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
  public async create(device: Device, credentialHash: string): Promise<void> {
    await this.store.createDevice(device, credentialHash);
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
    // Surface the real placement instead of fabricated constants: support
    // compares these values against the route_epoch embedded in tickets.
    const store = this.env.ADMIN_CONTROL.getByName("control");
    const device = await store.getDevice(id);
    const route =
      device === undefined ? undefined : (await store.listRoutesForDevice(device.accountId, id))[0];
    return {
      queueCount: BigInt(value.queuedMessageCount),
      queueBytes: BigInt(value.queueBytes),
      ackLag: BigInt(value.ackLag),
      homeRegion: route?.homeRegion ?? "cloudflare",
      routeEpoch: route?.routeEpoch ?? 0n,
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

function pairingFromRow(row: PairingRow): PairingRecord {
  return {
    pairingId: row.pairing_id,
    hostName: row.host_name,
    hostPublicKey: new Uint8Array(row.host_public_key),
    challengeHash: new Uint8Array(row.challenge_hash),
    watchSecretHash: row.watch_secret_hash,
    state: row.state,
    ...(row.account_id === null ? {} : { accountId: row.account_id }),
    ...(row.mobile_device_id === null ? {} : { mobileDeviceId: row.mobile_device_id }),
    ...(row.mobile_public_key === null
      ? {}
      : { mobilePublicKey: new Uint8Array(row.mobile_public_key) }),
    ...(row.host_device_id === null ? {} : { hostDeviceId: row.host_device_id }),
    ...(row.route_id === null ? {} : { routeId: row.route_id }),
    hostConfirmed: row.host_confirmed !== 0,
    mobileConfirmed: row.mobile_confirmed !== 0,
    expiresAtMs: BigInt(row.expires_at_ms),
    createdAtMs: BigInt(row.created_at_ms),
  };
}

function routeFromRow(row: RouteRow): RouteRecord {
  return {
    routeId: row.route_id,
    accountId: row.account_id,
    ...(row.host_device_id === null ? {} : { hostDeviceId: row.host_device_id }),
    mobileDeviceId: row.mobile_device_id,
    homeRegion: row.home_region,
    standbyRegion: row.standby_region,
    relayOrigin: row.relay_origin,
    routeEpoch: BigInt(row.route_epoch),
    frozen: row.frozen !== 0,
    createdAtMs: BigInt(row.created_at_ms),
  };
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function bytesBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

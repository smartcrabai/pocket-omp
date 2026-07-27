import { SQL } from "bun";
import { SignJWT, importPKCS8 } from "jose";
import {
  accountId,
  deviceId,
  pairingId,
  routeId,
  type Account,
  type Attachment,
  type AdminAuditRepository,
  type AdminAuthorizationRepository,
  type AdminRole,
  type AttachmentRepository,
  type AccountId,
  type AccountRepository,
  type Clock,
  type ControlOutbox,
  type CredentialHasher,
  type Device,
  type DeviceId,
  type DeviceRepository,
  type EntitlementRepository,
  type EntitlementState,
  type IdGenerator,
  type PairingId,
  type PairingRecord,
  type PairingRepository,
  type PairingSecrets,
  type PairingState,
  type ProtectedSecret,
  type PushGateway,
  type PushToken,
  type PushTokenRepository,
  type RelayDiagnosticsReader,
  type PushWorkItem,
  type PushWorkQueue,
  type RegionRoute,
  type RegionRouteRepository,
  type RelayTicketClaims,
  type RelayTicketSigner,
  type RouteId,
  type SecretProtector,
  type SubscriptionEvent,
  type VerifiedIdentity,
} from "@pocket-omp/control-core";

export class SystemClock implements Clock {
  public nowMs(): bigint {
    return BigInt(Date.now());
  }
}

export class UuidV7Generator implements IdGenerator {
  public newId(): string {
    return Bun.randomUUIDv7();
  }
}

export class Argon2CredentialHasher implements CredentialHasher {
  public hash(credential: string): Promise<string> {
    return hashCredential(credential);
  }
}

export async function hashCredential(credential: string): Promise<string> {
  if (credential.length < 32 || credential.length > 4096) {
    throw new CredentialAdapterError("INVALID_CREDENTIAL");
  }
  return Bun.password.hash(credential, { algorithm: "argon2id", memoryCost: 65_536, timeCost: 3 });
}

export async function verifyCredential(credential: string, hash: string): Promise<boolean> {
  if (credential.length === 0 || hash.length === 0) return false;
  try {
    return await Bun.password.verify(credential, hash, "argon2id");
  } catch {
    return false;
  }
}

export class CredentialAdapterError extends Error {
  public constructor(public readonly code: "INVALID_CREDENTIAL") {
    super(code);
    this.name = "CredentialAdapterError";
  }
}

export class AesGcmSecretProtector implements SecretProtector {
  private constructor(
    private readonly key: CryptoKey,
    private readonly keyId: string,
  ) {}

  public static async fromRawKey(key: Uint8Array, keyId: string): Promise<AesGcmSecretProtector> {
    if (key.byteLength !== 32 || keyId.length === 0 || keyId.length > 128) {
      throw new ControlAdapterError("INVALID_ENCRYPTION_KEY");
    }
    const cryptoKey = await crypto.subtle.importKey("raw", Uint8Array.from(key), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return new AesGcmSecretProtector(cryptoKey, keyId);
  }

  public hash(value: string): Uint8Array {
    return new Uint8Array(new Bun.CryptoHasher("sha256").update(value).digest());
  }

  public async encrypt(value: string): Promise<ProtectedSecret> {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        this.key,
        new TextEncoder().encode(value),
      ),
    );
    const ciphertext = new Uint8Array(nonce.byteLength + encrypted.byteLength);
    ciphertext.set(nonce);
    ciphertext.set(encrypted, nonce.byteLength);
    return { keyId: this.keyId, ciphertext };
  }

  public async decrypt(value: ProtectedSecret): Promise<string> {
    if (value.keyId !== this.keyId || value.ciphertext.byteLength < 29) {
      throw new ControlAdapterError("DECRYPTION_FAILED");
    }
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: Uint8Array.from(value.ciphertext.subarray(0, 12)) },
        this.key,
        Uint8Array.from(value.ciphertext.subarray(12)),
      );
      return new TextDecoder().decode(decrypted);
    } catch {
      throw new ControlAdapterError("DECRYPTION_FAILED");
    }
  }
}

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class ExpoPushGateway implements PushGateway {
  public constructor(
    private readonly fetchImplementation: FetchImplementation = globalThis.fetch,
    private readonly endpoint = new URL("https://exp.host/--/api/v2/push/send"),
  ) {}

  public async send(
    token: string,
    payload: { readonly kind: "WAKE"; readonly wakeId: string },
  ): Promise<void> {
    const response = await this.fetchImplementation(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        to: token,
        data: { kind: payload.kind, wake_id: payload.wakeId },
        priority: "high",
      }),
    });
    if (!response.ok) throw new ControlAdapterError("PUSH_FAILED");
    const body: unknown = await response.json();
    if (
      !isUnknownRecord(body) ||
      !Array.isArray(body.data) ||
      body.data.some((item) => isUnknownRecord(item) && item.status === "error")
    ) {
      throw new ControlAdapterError("PUSH_FAILED");
    }
  }
}

export class RevenueCatWebhookVerifier {
  private readonly expectedAuthorization: Uint8Array;

  public constructor(authorizationHeader: string) {
    if (authorizationHeader.length < 32 || authorizationHeader.length > 4096) {
      throw new ControlAdapterError("INVALID_WEBHOOK_SECRET");
    }
    this.expectedAuthorization = new TextEncoder().encode(authorizationHeader);
  }

  public verifyAndNormalize(
    rawBody: Uint8Array,
    authorizationHeader: string | null,
    receivedAtMs: bigint,
  ): {
    readonly accountId: AccountId;
    readonly event: SubscriptionEvent;
  } {
    const supplied = new TextEncoder().encode(authorizationHeader ?? "");
    if (!constantTimeBytes(this.expectedAuthorization, supplied)) {
      throw new ControlAdapterError("INVALID_WEBHOOK_AUTHORIZATION");
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBody));
    const root = objectValue(parsed, "RevenueCat payload");
    const event = objectValue(root.event, "RevenueCat event");
    const providerEventId = stringValue(event.id, "event.id");
    const account = accountId(stringValue(event.app_user_id, "event.app_user_id"));
    const eventType = stringValue(event.type, "event.type");
    const occurredAtMs = bigintValue(event.event_timestamp_ms, "event.event_timestamp_ms");
    const entitlementIds = stringArray(event.entitlement_ids);
    const expirationAtMs = optionalBigint(event.expiration_at_ms);
    const gracePeriodExpirationAtMs = optionalBigint(event.grace_period_expiration_at_ms);
    const includesRelayPro = entitlementIds.includes("relay_pro");
    let state: EntitlementState;
    switch (eventType) {
      case "INITIAL_PURCHASE":
      case "RENEWAL":
      case "UNCANCELLATION":
      case "PRODUCT_CHANGE":
        if (!includesRelayPro || expirationAtMs === undefined)
          throw new ControlAdapterError("INVALID_WEBHOOK_PAYLOAD");
        state = { kind: "active", usableUntilMs: expirationAtMs };
        break;
      case "BILLING_ISSUE":
        state =
          gracePeriodExpirationAtMs === undefined
            ? {
                kind: "billing-retry",
                ...(expirationAtMs === undefined ? {} : { usableUntilMs: expirationAtMs }),
              }
            : { kind: "grace-period", usableUntilMs: gracePeriodExpirationAtMs };
        break;
      case "CANCELLATION":
        state =
          includesRelayPro && expirationAtMs !== undefined && expirationAtMs > occurredAtMs
            ? { kind: "active", usableUntilMs: expirationAtMs }
            : { kind: "expired" };
        break;
      case "EXPIRATION":
        state = { kind: "expired" };
        break;
      case "REFUND":
        state = { kind: "refunded" };
        break;
      case "SUBSCRIPTION_PAUSED":
        state = { kind: "paused" };
        break;
      default:
        throw new ControlAdapterError("UNSUPPORTED_WEBHOOK_EVENT");
    }
    return {
      accountId: account,
      event: { providerEventId, occurredAtMs, receivedAtMs, state },
    };
  }
}

export class Ed25519RelayTicketSigner implements RelayTicketSigner {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly keyId: string,
  ) {}

  public static async fromPkcs8(
    privateKeyPem: string,
    keyId: string,
  ): Promise<Ed25519RelayTicketSigner> {
    if (keyId.length === 0 || keyId.length > 128)
      throw new ControlAdapterError("INVALID_SIGNING_KEY");
    return new Ed25519RelayTicketSigner(await importPKCS8(privateKeyPem, "EdDSA"), keyId);
  }

  public sign(claims: RelayTicketClaims): Promise<string> {
    return new SignJWT({
      account_id: claims.accountId,
      device_id: claims.deviceId,
      device_kind: claims.deviceKind,
      route_grants: claims.routeGrants,
      entitlement: claims.entitlement,
      credential_generation: safeInteger(claims.credentialGeneration),
      home_region: claims.homeRegion,
      relay_origin: claims.relayOrigin.toString(),
      route_epoch: safeInteger(claims.routeEpoch),
    })
      .setProtectedHeader({ alg: "EdDSA", kid: this.keyId, typ: "JWT" })
      .setIssuer(claims.issuer)
      .setAudience(claims.audience)
      .setSubject(claims.deviceId)
      .setIssuedAt(safeInteger(claims.issuedAtSeconds))
      .setExpirationTime(safeInteger(claims.expiresAtSeconds))
      .setJti(claims.ticketId)
      .sign(this.privateKey);
  }
}
export class BunPairingSecrets implements PairingSecrets {
  public randomBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length <= 0 || length > 4096) {
      throw new ControlAdapterError("INVALID_RANDOM_LENGTH");
    }
    return crypto.getRandomValues(new Uint8Array(length));
  }

  public hashBytes(value: Uint8Array): Uint8Array {
    return new Uint8Array(new Bun.CryptoHasher("sha256").update(value).digest());
  }

  public hashOpaque(value: string): Promise<string> {
    return hashCredential(value);
  }

  public verifyOpaque(value: string, hash: string): Promise<boolean> {
    return verifyCredential(value, hash);
  }
}

interface AccountRow {
  readonly account_id: string;
  readonly status: Account["status"];
  readonly created_at: Date;
}

interface DeviceRow {
  readonly device_id: string;
  readonly account_id: string;
  readonly kind: Device["kind"];
  readonly name: string;
  readonly public_key: Uint8Array;
  readonly credential_generation: string | number | bigint;
  readonly revoked_at: Date | null;
  readonly last_seen_at: Date;
}

interface RouteRow {
  readonly route_id: string;
  readonly account_id: string;
  readonly host_device_id: string;
  readonly mobile_device_id: string;
  readonly home_region: string;
  readonly standby_region: string;
  readonly relay_origin: string;
  readonly route_epoch: string | number | bigint;
  readonly frozen: boolean;
}

interface EntitlementRow {
  readonly state: EntitlementState["kind"];
  readonly usable_until: Date | null;
}

interface PairingRow {
  readonly pairing_id: string;
  readonly account_id: string | null;
  readonly host_device_id: string | null;
  readonly mobile_device_id: string | null;
  readonly route_id: string | null;
  readonly host_name: string;
  readonly host_public_key: Uint8Array;
  readonly mobile_public_key: Uint8Array | null;
  readonly challenge_hash: Uint8Array;
  readonly watch_secret_hash: string;
  readonly transcript_hash: Uint8Array | null;
  readonly host_confirmed: boolean;
  readonly mobile_confirmed: boolean;
  readonly state: PairingState["kind"];
  readonly expires_at: Date;
}

interface PushTokenRow {
  readonly registration_id: string;
  readonly account_id: string;
  readonly device_id: string;
  readonly provider: PushToken["provider"];
  readonly encrypted_token: Uint8Array;
  readonly encryption_key_id: string;
}

interface AttachmentRow {
  readonly object_id: string;
  readonly account_id: string;
  readonly ciphertext_size: string | number | bigint;
  readonly ciphertext_hash: Uint8Array;
  readonly storage_region: string;
  readonly status: Attachment["status"];
  readonly expires_at: Date;
}

interface PushWorkRow {
  readonly event_id: string;
  readonly payload: unknown;
}

export class PostgresControlStore {
  public constructor(private readonly database: SQL) {}

  public static async connect(databaseUrl: string): Promise<PostgresControlStore> {
    const database = new SQL(databaseUrl);
    await database`SELECT 1`;
    return new PostgresControlStore(database);
  }

  public async close(): Promise<void> {
    await this.database.close();
  }

  public async migrate(): Promise<void> {
    const migrations = [
      ["0001_control", new URL("../../../db/control/0001_control.sql", import.meta.url).pathname],
      [
        "0002_pairing_route",
        new URL("../../../db/control/0002_pairing_route.sql", import.meta.url).pathname,
      ],
      [
        "0003_outbox_lease",
        new URL("../../../db/control/0003_outbox_lease.sql", import.meta.url).pathname,
      ],
    ] as const;
    await this.database.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('pocket-omp-control-migrations', 0))`;
      await transaction`CREATE SCHEMA IF NOT EXISTS control`;
      await transaction`CREATE TABLE IF NOT EXISTS control.schema_migration (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      /* oxlint-disable eslint/no-await-in-loop -- Schema migrations must execute serially inside one advisory-locked transaction. */
      for (const [version, file] of migrations) {
        const applied = await transaction<
          { version: string }[]
        >`SELECT version FROM control.schema_migration WHERE version = ${version}`;
        if (applied.length !== 0) continue;
        await transaction.file(file);
        await transaction`INSERT INTO control.schema_migration (version) VALUES (${version})`;
      }
      /* oxlint-enable eslint/no-await-in-loop */
    });
  }

  public async findOrCreate(
    identity: VerifiedIdentity,
    newAccountId: AccountId,
    nowMs: bigint,
  ): Promise<Account> {
    return this.database.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`${identity.provider}:${identity.subject}`}, 0))`;
      const existing = await transaction<AccountRow[]>`
        SELECT a.account_id, a.status, a.created_at
        FROM control.auth_identity i JOIN control.account a USING (account_id)
        WHERE i.provider = ${identity.provider} AND i.provider_subject = ${identity.subject}
      `;
      if (existing[0] !== undefined) return accountFromRow(existing[0]);
      await transaction`
        INSERT INTO control.account (account_id, status, created_at)
        VALUES (${newAccountId}, 'active', ${dateFromMs(nowMs)})
      `;
      await transaction`
        INSERT INTO control.auth_identity (provider, provider_subject, account_id, email)
        VALUES (${identity.provider}, ${identity.subject}, ${newAccountId}, ${identity.email ?? null})
      `;
      return { accountId: newAccountId, status: "active", createdAtMs: nowMs };
    });
  }

  public async getAccount(id: AccountId): Promise<Account | undefined> {
    const accounts = await this.database<AccountRow[]>`
      SELECT account_id, status, created_at FROM control.account WHERE account_id = ${id}
    `;
    return accounts[0] === undefined ? undefined : accountFromRow(accounts[0]);
  }

  public async getDevice(id: DeviceId): Promise<Device | undefined> {
    const devices = await this.database<DeviceRow[]>`
      SELECT device_id, account_id, kind, name, public_key, credential_generation, revoked_at, last_seen_at
      FROM control.device WHERE device_id = ${id}
    `;
    return devices[0] === undefined ? undefined : deviceFromRow(devices[0]);
  }

  public async createDevice(device: Device, credentialHash: string): Promise<void> {
    await this.database.begin(async (transaction) => {
      await transaction`
        INSERT INTO control.device (device_id, account_id, kind, name, public_key, credential_generation, last_seen_at)
        VALUES (${device.deviceId}, ${device.accountId}, ${device.kind}, ${device.name}, ${device.publicKey}, ${device.credentialGeneration}, ${dateFromMs(device.lastSeenAtMs)})
      `;
      await transaction`
        INSERT INTO control.device_credential (device_id, generation, credential_hash)
        VALUES (${device.deviceId}, ${device.credentialGeneration}, ${credentialHash})
      `;
      if (device.kind === "HOST") {
        await transaction`INSERT INTO control.host (host_id, device_id) VALUES (${device.deviceId}, ${device.deviceId})`;
      }
    });
  }

  public async listDevices(account: AccountId): Promise<readonly Device[]> {
    const rows = await this.database<DeviceRow[]>`
      SELECT device_id, account_id, kind, name, public_key, credential_generation, revoked_at, last_seen_at
      FROM control.device WHERE account_id = ${account} ORDER BY created_at, device_id
    `;
    return rows.map(deviceFromRow);
  }

  public async revokeDevice(account: AccountId, id: DeviceId, nowMs: bigint): Promise<bigint> {
    return this.database.begin(async (transaction) => {
      const rows = await transaction<{ credential_generation: string | number | bigint }[]>`
        UPDATE control.device
        SET revoked_at = COALESCE(revoked_at, ${dateFromMs(nowMs)}), credential_generation = credential_generation + 1
        WHERE account_id = ${account} AND device_id = ${id} AND revoked_at IS NULL
        RETURNING credential_generation
      `;
      const row = rows[0];
      if (row === undefined) throw new ControlAdapterError("DEVICE_NOT_ACTIVE");
      await transaction`
        UPDATE control.device_credential SET revoked_at = ${dateFromMs(nowMs)}
        WHERE device_id = ${id} AND revoked_at IS NULL
      `;
      return BigInt(row.credential_generation);
    });
  }

  public async listRoutesForDevice(
    account: AccountId,
    id: DeviceId,
  ): Promise<readonly RegionRoute[]> {
    const rows = await this.database<RouteRow[]>`
      SELECT p.route_id, p.account_id, p.host_device_id, p.mobile_device_id,
             r.home_region, r.standby_region, r.relay_origin, r.route_epoch, r.frozen
      FROM control.route_pair p JOIN control.region_route r USING (route_id)
      WHERE p.account_id = ${account} AND (${id} = p.host_device_id OR ${id} = p.mobile_device_id)
      ORDER BY p.route_id
    `;
    return rows.map(routeFromRow);
  }

  public async createRoute(value: RegionRoute): Promise<void> {
    await this.database.begin(async (transaction) => {
      await transaction`
        INSERT INTO control.route_pair (route_id, account_id, host_device_id, mobile_device_id)
        VALUES (${value.routeId}, ${value.accountId}, ${value.hostDeviceId}, ${value.mobileDeviceId})
      `;
      await transaction`
        INSERT INTO control.region_route (route_id, home_region, standby_region, relay_origin, route_epoch, frozen)
        VALUES (${value.routeId}, ${value.homeRegion}, ${value.standbyRegion}, ${value.relayOrigin.toString()}, ${value.routeEpoch}, ${value.frozen})
      `;
    });
  }

  public async promoteRoute(
    id: RouteId,
    expectedEpoch: bigint,
    homeRegion: string,
    standbyRegion: string,
  ): Promise<RegionRoute> {
    const rows = await this.database<RouteRow[]>`
      UPDATE control.region_route r
      SET home_region = ${homeRegion}, standby_region = ${standbyRegion}, route_epoch = route_epoch + 1, frozen = false, updated_at = now()
      FROM control.route_pair p
      WHERE r.route_id = ${id} AND r.route_epoch = ${expectedEpoch} AND r.frozen = true AND p.route_id = r.route_id
      RETURNING p.route_id, p.account_id, p.host_device_id, p.mobile_device_id,
                r.home_region, r.standby_region, r.relay_origin, r.route_epoch, r.frozen
    `;
    const row = rows[0];
    if (row === undefined) throw new ControlAdapterError("ROUTE_PROMOTION_CONFLICT");
    return routeFromRow(row);
  }

  public async getEntitlement(account: AccountId): Promise<EntitlementState | undefined> {
    const rows = await this.database<EntitlementRow[]>`
      SELECT state, usable_until FROM control.entitlement WHERE account_id = ${account}
    `;
    const row = rows[0];
    if (row === undefined) return undefined;
    if (row.state === "active" || row.state === "grace-period") {
      if (row.usable_until === null) throw new ControlAdapterError("CORRUPT_ENTITLEMENT");
      return { kind: row.state, usableUntilMs: BigInt(row.usable_until.getTime()) };
    }
    if (row.state === "billing-retry" && row.usable_until !== null) {
      return { kind: row.state, usableUntilMs: BigInt(row.usable_until.getTime()) };
    }
    return { kind: row.state };
  }

  public async applyEntitlementEvent(
    account: AccountId,
    event: SubscriptionEvent,
  ): Promise<boolean> {
    return this.database.begin(async (transaction) => {
      const inserted = await transaction`
        INSERT INTO control.billing_event (provider_event_id, account_id, event_type, occurred_at, received_at, payload_hash)
        VALUES (${event.providerEventId}, ${account}, ${event.state.kind}, ${dateFromMs(event.occurredAtMs)}, ${dateFromMs(event.receivedAtMs)}, ${eventHash(event)})
        ON CONFLICT (provider_event_id) DO NOTHING
        RETURNING provider_event_id
      `;
      if (inserted.length === 0) return false;
      const usableUntilMs = "usableUntilMs" in event.state ? event.state.usableUntilMs : undefined;
      const updated = await transaction`
        INSERT INTO control.entitlement (account_id, state, usable_until, last_occurred_at)
        VALUES (${account}, ${event.state.kind}, ${usableUntilMs === undefined ? null : dateFromMs(usableUntilMs)}, ${dateFromMs(event.occurredAtMs)})
        ON CONFLICT (account_id) DO UPDATE SET
          state = EXCLUDED.state,
          usable_until = EXCLUDED.usable_until,
          last_occurred_at = EXCLUDED.last_occurred_at,
          updated_at = now()
        WHERE control.entitlement.last_occurred_at <= EXCLUDED.last_occurred_at
        RETURNING account_id
      `;
      await transaction`UPDATE control.billing_event SET processed_at = now() WHERE provider_event_id = ${event.providerEventId}`;
      return updated.length === 1;
    });
  }

  public async appendOutbox(event: {
    readonly eventId: string;
    readonly kind: string;
    readonly payload: unknown;
  }): Promise<void> {
    await this.database`
      INSERT INTO control.outbox (event_id, kind, payload)
      VALUES (${event.eventId}, ${event.kind}, ${JSON.stringify(event.payload)})
    `;
  }

  public async createPairing(record: PairingRecord): Promise<void> {
    const expiresAtMs = pairingExpiresAt(record.state);
    await this.database`
      INSERT INTO control.pairing_request (
        pairing_id, host_name, host_public_key, challenge_hash, watch_secret_hash, state, expires_at
      ) VALUES (
        ${record.state.pairingId}, ${record.hostName}, ${record.hostPublicKey}, ${record.challengeHash},
        ${record.watchSecretHash}, ${record.state.kind}, ${dateFromMs(expiresAtMs)}
      )
    `;
  }

  public async getPairing(id: PairingId): Promise<PairingRecord | undefined> {
    const rows = await this.database<PairingRow[]>`
      SELECT pairing_id, account_id, host_device_id, mobile_device_id, route_id, host_name,
             host_public_key, mobile_public_key, challenge_hash, watch_secret_hash, transcript_hash,
             host_confirmed, mobile_confirmed, state, expires_at
      FROM control.pairing_request WHERE pairing_id = ${id}
    `;
    return rows[0] === undefined ? undefined : pairingFromRow(rows[0]);
  }

  public async savePairing(
    record: PairingRecord,
    expectedKind: PairingState["kind"],
  ): Promise<void> {
    const rows = await this.database`
      UPDATE control.pairing_request SET
        account_id = ${record.accountId ?? null},
        host_device_id = ${record.hostDeviceId ?? null},
        mobile_device_id = ${record.mobileDeviceId ?? null},
        mobile_public_key = ${record.mobilePublicKey ?? null},
        transcript_hash = ${pairingTranscriptHash(record.state)},
        host_confirmed = ${record.state.kind === "awaiting-confirmations" && record.state.hostConfirmed},
        mobile_confirmed = ${record.state.kind === "awaiting-confirmations" && record.state.mobileConfirmed},
        state = ${record.state.kind},
        route_id = ${record.state.kind === "completed" ? record.state.routeId : null}
      WHERE pairing_id = ${record.state.pairingId} AND state = ${expectedKind}
      RETURNING pairing_id
    `;
    if (rows.length !== 1) throw new ControlAdapterError("PAIRING_CONFLICT");
  }

  public async completePairing(record: PairingRecord, route: RegionRoute): Promise<void> {
    await this.database.begin(async (transaction) => {
      const updated = await transaction`
        UPDATE control.pairing_request SET
          host_device_id = ${route.hostDeviceId}, state = 'completed', route_id = ${route.routeId}
        WHERE pairing_id = ${record.state.pairingId} AND state = 'awaiting-confirmations'
          AND host_confirmed = true AND mobile_confirmed = true
        RETURNING pairing_id
      `;
      if (updated.length !== 1) throw new ControlAdapterError("PAIRING_CONFLICT");
      await transaction`
        INSERT INTO control.route_pair (route_id, account_id, host_device_id, mobile_device_id)
        VALUES (${route.routeId}, ${route.accountId}, ${route.hostDeviceId}, ${route.mobileDeviceId})
      `;
      await transaction`
        INSERT INTO control.region_route (route_id, home_region, standby_region, relay_origin, route_epoch, frozen)
        VALUES (${route.routeId}, ${route.homeRegion}, ${route.standbyRegion}, ${route.relayOrigin.toString()}, ${route.routeEpoch}, ${route.frozen})
      `;
    });
  }

  public async upsertPushToken(token: PushToken, tokenHash: Uint8Array): Promise<string> {
    const rows = await this.database<{ registration_id: string }[]>`
      INSERT INTO control.push_token (
        registration_id, account_id, device_id, provider, token_hash, encrypted_token, encryption_key_id
      ) VALUES (
        ${token.registrationId}, ${token.accountId}, ${token.deviceId}, ${token.provider}, ${tokenHash},
        ${token.protectedToken.ciphertext}, ${token.protectedToken.keyId}
      )
      ON CONFLICT (provider, token_hash) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        device_id = EXCLUDED.device_id,
        encrypted_token = EXCLUDED.encrypted_token,
        encryption_key_id = EXCLUDED.encryption_key_id,
        revoked_at = NULL
      RETURNING registration_id
    `;
    const registration = rows[0];
    if (registration === undefined) throw new ControlAdapterError("PUSH_FAILED");
    return registration.registration_id;
  }

  public async listPushTokens(id: DeviceId): Promise<readonly PushToken[]> {
    const rows = await this.database<PushTokenRow[]>`
      SELECT registration_id, account_id, device_id, provider, encrypted_token, encryption_key_id
      FROM control.push_token WHERE device_id = ${id} AND revoked_at IS NULL ORDER BY created_at
    `;
    return rows.map((row) => ({
      registrationId: row.registration_id,
      accountId: accountId(row.account_id),
      deviceId: deviceId(row.device_id),
      provider: row.provider,
      protectedToken: {
        keyId: row.encryption_key_id,
        ciphertext: new Uint8Array(row.encrypted_token),
      },
    }));
  }

  public async createAttachment(attachment: Attachment): Promise<void> {
    await this.database`
      INSERT INTO control.attachment (
        object_id, account_id, ciphertext_size, ciphertext_hash, storage_region, status, expires_at
      ) VALUES (
        ${attachment.objectId}, ${attachment.accountId}, ${attachment.ciphertextSize}, ${attachment.ciphertextHash},
        ${attachment.storageRegion}, ${attachment.status}, ${dateFromMs(attachment.expiresAtMs)}
      )
    `;
  }

  public async getAttachment(objectId: string): Promise<Attachment | undefined> {
    const rows = await this.database<AttachmentRow[]>`
      SELECT object_id, account_id, ciphertext_size, ciphertext_hash, storage_region, status, expires_at
      FROM control.attachment WHERE object_id = ${objectId}
    `;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          objectId: row.object_id,
          accountId: accountId(row.account_id),
          ciphertextSize: BigInt(row.ciphertext_size),
          ciphertextHash: new Uint8Array(row.ciphertext_hash),
          storageRegion: row.storage_region,
          status: row.status,
          expiresAtMs: BigInt(row.expires_at.getTime()),
        };
  }
  public async leasePushWork(
    owner: string,
    nowMs: bigint,
    limit: number,
  ): Promise<readonly PushWorkItem[]> {
    const rows = await this.database<PushWorkRow[]>`
      WITH candidates AS (
        SELECT event_id FROM control.outbox
        WHERE kind = 'PushWakeRequested' AND published_at IS NULL
          AND (leased_until IS NULL OR leased_until < ${dateFromMs(nowMs)})
        ORDER BY occurred_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE control.outbox o SET
        lease_owner = ${owner},
        leased_until = ${dateFromMs(nowMs + 30_000n)},
        attempts = attempts + 1
      FROM candidates c WHERE o.event_id = c.event_id
      RETURNING o.event_id, o.payload
    `;
    return rows.map((row) => {
      const payload = objectValue(row.payload, "PushWakeRequested payload");
      return {
        eventId: row.event_id,
        deviceId: deviceId(stringValue(payload.deviceId, "payload.deviceId")),
        wakeId: stringValue(payload.wakeId, "payload.wakeId"),
      };
    });
  }

  public async completePushWork(eventId: string, owner: string, nowMs: bigint): Promise<void> {
    const rows = await this.database`
      UPDATE control.outbox SET published_at = ${dateFromMs(nowMs)}, lease_owner = NULL, leased_until = NULL
      WHERE event_id = ${eventId} AND lease_owner = ${owner} AND published_at IS NULL
      RETURNING event_id
    `;
    if (rows.length !== 1) throw new ControlAdapterError("OUTBOX_LEASE_CONFLICT");
  }

  public async retryPushWork(eventId: string, owner: string, errorCode: string): Promise<void> {
    const rows = await this.database`
      UPDATE control.outbox SET lease_owner = NULL, leased_until = NULL, last_error = ${errorCode}
      WHERE event_id = ${eventId} AND lease_owner = ${owner} AND published_at IS NULL
      RETURNING event_id
    `;
    if (rows.length !== 1) throw new ControlAdapterError("OUTBOX_LEASE_CONFLICT");
  }

  public async hasActiveAdminGrant(
    staffSubject: string,
    account: AccountId,
    grantId: string,
    requiredRole: AdminRole,
    nowMs: bigint,
  ): Promise<boolean> {
    const rows = await this.database<{ allowed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM control.admin_role ar
        JOIN control.support_access_grant sag ON sag.staff_subject = ar.staff_subject
        WHERE ar.staff_subject = ${staffSubject} AND ar.role = ${requiredRole}
          AND sag.grant_id = ${grantId} AND sag.account_id = ${account}
          AND sag.revoked_at IS NULL AND sag.expires_at > ${dateFromMs(nowMs)}
      ) AS allowed
    `;
    return rows[0]?.allowed === true;
  }

  public async appendAdminAudit(
    event: Parameters<AdminAuditRepository["append"]>[0],
  ): Promise<void> {
    await this.database`
      INSERT INTO control.admin_audit_event (
        event_id, staff_subject, action, account_id, target_id, correlation_id, metadata
      ) VALUES (
        ${event.eventId}, ${event.staffSubject}, ${event.action}, ${event.accountId ?? null},
        ${event.targetId ?? null}, ${event.correlationId}, ${JSON.stringify(event.metadata)}
      )
    `;
  }

  public async provisionSupportAccess(
    staffSubject: string,
    role: AdminRole,
    grantId: string,
    account: AccountId,
    reason: string,
    expiresAtMs: bigint,
  ): Promise<void> {
    await this.database.begin(async (transaction) => {
      await transaction`
        INSERT INTO control.admin_role (staff_subject, role) VALUES (${staffSubject}, ${role})
        ON CONFLICT DO NOTHING
      `;
      await transaction`
        INSERT INTO control.support_access_grant (grant_id, staff_subject, account_id, reason, expires_at)
        VALUES (${grantId}, ${staffSubject}, ${account}, ${reason}, ${dateFromMs(expiresAtMs)})
      `;
    });
  }
}

export class PostgresAccountRepository implements AccountRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public findOrCreate(
    identity: VerifiedIdentity,
    newAccountId: AccountId,
    nowMs: bigint,
  ): Promise<Account> {
    return this.store.findOrCreate(identity, newAccountId, nowMs);
  }
  public get(id: AccountId): Promise<Account | undefined> {
    return this.store.getAccount(id);
  }
}

export class PostgresDeviceRepository implements DeviceRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public create(device: Device, credentialHash: string): Promise<void> {
    return this.store.createDevice(device, credentialHash);
  }

  public get(id: DeviceId): Promise<Device | undefined> {
    return this.store.getDevice(id);
  }
  public list(account: AccountId): Promise<readonly Device[]> {
    return this.store.listDevices(account);
  }
  public revoke(account: AccountId, id: DeviceId, nowMs: bigint): Promise<bigint> {
    return this.store.revokeDevice(account, id, nowMs);
  }
}

export class PostgresRegionRouteRepository implements RegionRouteRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public listForDevice(account: AccountId, id: DeviceId): Promise<readonly RegionRoute[]> {
    return this.store.listRoutesForDevice(account, id);
  }
  public create(route: RegionRoute): Promise<void> {
    return this.store.createRoute(route);
  }
  public promote(
    id: RouteId,
    expectedEpoch: bigint,
    homeRegion: string,
    standbyRegion: string,
  ): Promise<RegionRoute> {
    return this.store.promoteRoute(id, expectedEpoch, homeRegion, standbyRegion);
  }
}

export class PostgresEntitlementRepository implements EntitlementRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public get(account: AccountId): Promise<EntitlementState | undefined> {
    return this.store.getEntitlement(account);
  }
  public applyEvent(account: AccountId, event: SubscriptionEvent): Promise<boolean> {
    return this.store.applyEntitlementEvent(account, event);
  }
}

export class PostgresControlOutbox implements ControlOutbox {
  public constructor(private readonly store: PostgresControlStore) {}
  public append(event: {
    readonly eventId: string;
    readonly kind: string;
    readonly payload: unknown;
  }): Promise<void> {
    return this.store.appendOutbox(event);
  }
}

export class PostgresPairingRepository implements PairingRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public create(record: PairingRecord): Promise<void> {
    return this.store.createPairing(record);
  }
  public get(id: PairingId): Promise<PairingRecord | undefined> {
    return this.store.getPairing(id);
  }
  public save(record: PairingRecord, expectedKind: PairingState["kind"]): Promise<void> {
    return this.store.savePairing(record, expectedKind);
  }
  public complete(record: PairingRecord, route: RegionRoute): Promise<void> {
    return this.store.completePairing(record, route);
  }
}

export class PostgresPushTokenRepository implements PushTokenRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public upsert(token: PushToken, tokenHash: Uint8Array): Promise<string> {
    return this.store.upsertPushToken(token, tokenHash);
  }
  public listActive(id: DeviceId): Promise<readonly PushToken[]> {
    return this.store.listPushTokens(id);
  }
}

export class PostgresAttachmentRepository implements AttachmentRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public create(attachment: Attachment): Promise<void> {
    return this.store.createAttachment(attachment);
  }
  public get(objectId: string): Promise<Attachment | undefined> {
    return this.store.getAttachment(objectId);
  }
}

export class PostgresPushWorkQueue implements PushWorkQueue {
  public constructor(private readonly store: PostgresControlStore) {}
  public lease(owner: string, nowMs: bigint, limit: number): Promise<readonly PushWorkItem[]> {
    return this.store.leasePushWork(owner, nowMs, limit);
  }
  public complete(eventId: string, owner: string, nowMs: bigint): Promise<void> {
    return this.store.completePushWork(eventId, owner, nowMs);
  }
  public retry(eventId: string, owner: string, errorCode: string): Promise<void> {
    return this.store.retryPushWork(eventId, owner, errorCode);
  }
}

export class PostgresAdminSecurity implements AdminAuthorizationRepository, AdminAuditRepository {
  public constructor(private readonly store: PostgresControlStore) {}
  public hasActiveGrant(
    staffSubject: string,
    account: AccountId,
    grantId: string,
    requiredRole: AdminRole,
    nowMs: bigint,
  ): Promise<boolean> {
    return this.store.hasActiveAdminGrant(staffSubject, account, grantId, requiredRole, nowMs);
  }
  public append(event: Parameters<AdminAuditRepository["append"]>[0]): Promise<void> {
    return this.store.appendAdminAudit(event);
  }
}

interface RelayDiagnosticsRow {
  readonly queue_count: string | number | bigint;
  readonly queue_bytes: string | number | bigint;
  readonly ack_lag: string | number | bigint;
  readonly home_region: string;
  readonly route_epoch: string | number | bigint;
}

export class PostgresRelayDiagnosticsReader implements RelayDiagnosticsReader {
  private constructor(private readonly database: SQL) {}

  public static async connect(databaseUrl: string): Promise<PostgresRelayDiagnosticsReader> {
    const database = new SQL(databaseUrl);
    await database`SELECT 1`;
    return new PostgresRelayDiagnosticsReader(database);
  }

  public async close(): Promise<void> {
    await this.database.close();
  }

  public async getDeliveryMetadata(id: DeviceId): Promise<{
    readonly queueCount: bigint;
    readonly queueBytes: bigint;
    readonly ackLag: bigint;
    readonly homeRegion: string;
    readonly routeEpoch: bigint;
  }> {
    const rows = await this.database<RelayDiagnosticsRow[]>`
      SELECT
        count(m.server_sequence) FILTER (WHERE m.delivery_state = 1) AS queue_count,
        COALESCE(sum(m.ciphertext_size) FILTER (WHERE m.delivery_state = 1), 0) AS queue_bytes,
        GREATEST(s.next_sequence - 1 - s.acked_sequence, 0) AS ack_lag,
        s.home_region,
        s.route_epoch
      FROM relay.recipient_state s
      LEFT JOIN relay.message m ON m.recipient_device_id = s.recipient_device_id
      WHERE s.recipient_device_id = ${id}
      GROUP BY s.recipient_device_id
    `;
    const row = rows[0];
    if (row === undefined)
      return {
        queueCount: 0n,
        queueBytes: 0n,
        ackLag: 0n,
        homeRegion: "unassigned",
        routeEpoch: 0n,
      };
    return {
      queueCount: BigInt(row.queue_count),
      queueBytes: BigInt(row.queue_bytes),
      ackLag: BigInt(row.ack_lag),
      homeRegion: row.home_region,
      routeEpoch: BigInt(row.route_epoch),
    };
  }
}

export class ControlAdapterError extends Error {
  public constructor(
    public readonly code:
      | "DEVICE_NOT_ACTIVE"
      | "CREDENTIAL_REQUIRED"
      | "ROUTE_PROMOTION_CONFLICT"
      | "CORRUPT_ENTITLEMENT"
      | "INVALID_SIGNING_KEY"
      | "INVALID_RANDOM_LENGTH"
      | "PAIRING_CONFLICT"
      | "INVALID_WEBHOOK_SECRET"
      | "INVALID_WEBHOOK_AUTHORIZATION"
      | "INVALID_WEBHOOK_PAYLOAD"
      | "UNSUPPORTED_WEBHOOK_EVENT"
      | "INVALID_ENCRYPTION_KEY"
      | "DECRYPTION_FAILED"
      | "PUSH_FAILED"
      | "OUTBOX_LEASE_CONFLICT",
  ) {
    super(code);
    this.name = "ControlAdapterError";
  }
}

function accountFromRow(row: AccountRow): Account {
  return {
    accountId: accountId(row.account_id),
    status: row.status,
    createdAtMs: BigInt(row.created_at.getTime()),
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
    ...(row.revoked_at === null ? {} : { revokedAtMs: BigInt(row.revoked_at.getTime()) }),
    lastSeenAtMs: BigInt(row.last_seen_at.getTime()),
  };
}

function routeFromRow(row: RouteRow): RegionRoute {
  return {
    routeId: routeId(row.route_id),
    accountId: accountId(row.account_id),
    hostDeviceId: deviceId(row.host_device_id),
    mobileDeviceId: deviceId(row.mobile_device_id),
    homeRegion: row.home_region,
    standbyRegion: row.standby_region,
    relayOrigin: new URL(row.relay_origin),
    routeEpoch: BigInt(row.route_epoch),
    frozen: row.frozen,
  };
}

function pairingFromRow(row: PairingRow): PairingRecord {
  const id = pairingId(row.pairing_id);
  const expiresAtMs = BigInt(row.expires_at.getTime());
  let state: PairingState;
  if (row.state === "awaiting-claim") {
    state = {
      kind: row.state,
      pairingId: id,
      expiresAtMs,
      challengeHash: new Uint8Array(row.challenge_hash),
    };
  } else if (row.state === "awaiting-confirmations") {
    if (row.transcript_hash === null) throw new ControlAdapterError("PAIRING_CONFLICT");
    state = {
      kind: row.state,
      pairingId: id,
      expiresAtMs,
      hostConfirmed: row.host_confirmed,
      mobileConfirmed: row.mobile_confirmed,
      transcriptHash: new Uint8Array(row.transcript_hash),
    };
  } else if (row.state === "completed") {
    if (row.route_id === null) throw new ControlAdapterError("PAIRING_CONFLICT");
    state = { kind: row.state, pairingId: id, routeId: routeId(row.route_id) };
  } else {
    state = { kind: "expired", pairingId: id };
  }
  return {
    state,
    hostName: row.host_name,
    hostPublicKey: new Uint8Array(row.host_public_key),
    challengeHash: new Uint8Array(row.challenge_hash),
    watchSecretHash: row.watch_secret_hash,
    ...(row.account_id === null ? {} : { accountId: accountId(row.account_id) }),
    ...(row.host_device_id === null ? {} : { hostDeviceId: deviceId(row.host_device_id) }),
    ...(row.mobile_device_id === null ? {} : { mobileDeviceId: deviceId(row.mobile_device_id) }),
    ...(row.mobile_public_key === null
      ? {}
      : { mobilePublicKey: new Uint8Array(row.mobile_public_key) }),
  };
}

function pairingExpiresAt(state: PairingState): bigint {
  if (state.kind === "awaiting-claim" || state.kind === "awaiting-confirmations")
    return state.expiresAtMs;
  throw new ControlAdapterError("PAIRING_CONFLICT");
}

function pairingTranscriptHash(state: PairingState): Uint8Array | null {
  return state.kind === "awaiting-confirmations" ? state.transcriptHash : null;
}

function safeInteger(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new ControlAdapterError("INVALID_SIGNING_KEY");
  return converted;
}

function dateFromMs(value: bigint): Date {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) throw new ControlAdapterError("CORRUPT_ENTITLEMENT");
  return new Date(milliseconds);
}

function eventHash(event: SubscriptionEvent): Uint8Array {
  const canonical = JSON.stringify({
    providerEventId: event.providerEventId,
    occurredAtMs: event.occurredAtMs.toString(),
    receivedAtMs: event.receivedAtMs.toString(),
    state: {
      ...event.state,
      ...("usableUntilMs" in event.state
        ? { usableUntilMs: event.state.usableUntilMs?.toString() }
        : {}),
    },
  });
  return new Uint8Array(new Bun.CryptoHasher("sha256").update(canonical).digest());
}

function constantTimeBytes(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return objectValue(parsed, name);
  }
  if (!isUnknownRecord(value)) throw new ControlAdapterError("INVALID_WEBHOOK_PAYLOAD");
  if (name.length === 0) throw new ControlAdapterError("INVALID_WEBHOOK_PAYLOAD");
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || name.length === 0) {
    throw new ControlAdapterError("INVALID_WEBHOOK_PAYLOAD");
  }
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: unknown[] = value;
  if (!items.every((item) => typeof item === "string")) {
    throw new ControlAdapterError("INVALID_WEBHOOK_PAYLOAD");
  }
  return items.map((item) => stringValue(item, "array item"));
}

function bigintValue(value: unknown, name: string): bigint {
  const converted = optionalBigint(value);
  if (converted === undefined || name.length === 0)
    throw new ControlAdapterError("INVALID_WEBHOOK_PAYLOAD");
  return converted;
}

function optionalBigint(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new ControlAdapterError("INVALID_WEBHOOK_PAYLOAD");
}

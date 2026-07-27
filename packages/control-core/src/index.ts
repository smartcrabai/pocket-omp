export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type AccountId = Brand<string, "AccountId">;
export type DeviceId = Brand<string, "DeviceId">;
export type PairingId = Brand<string, "PairingId">;
export type RouteId = Brand<string, "RouteId">;

export type EntitlementState =
  | { readonly kind: "active"; readonly usableUntilMs: bigint }
  | { readonly kind: "grace-period"; readonly usableUntilMs: bigint }
  | { readonly kind: "billing-retry"; readonly usableUntilMs?: bigint }
  | { readonly kind: "paused" }
  | { readonly kind: "expired" }
  | { readonly kind: "refunded" }
  | { readonly kind: "revoked" };

export function mayUseRelay(state: EntitlementState, nowMs: bigint): boolean {
  return (state.kind === "active" || state.kind === "grace-period") && state.usableUntilMs > nowMs;
}

export interface SubscriptionEvent {
  readonly providerEventId: string;
  readonly occurredAtMs: bigint;
  readonly receivedAtMs: bigint;
  readonly state: EntitlementState;
}

export function applySubscriptionEvent(
  current: { readonly state: EntitlementState; readonly lastOccurredAtMs: bigint } | undefined,
  event: SubscriptionEvent,
): {
  readonly state: EntitlementState;
  readonly lastOccurredAtMs: bigint;
  readonly changed: boolean;
} {
  if (current !== undefined && event.occurredAtMs < current.lastOccurredAtMs) {
    return { ...current, changed: false };
  }
  return { state: event.state, lastOccurredAtMs: event.occurredAtMs, changed: true };
}

export type PairingState =
  | {
      readonly kind: "awaiting-claim";
      readonly pairingId: PairingId;
      readonly expiresAtMs: bigint;
      readonly challengeHash: Uint8Array;
    }
  | {
      readonly kind: "awaiting-confirmations";
      readonly pairingId: PairingId;
      readonly expiresAtMs: bigint;
      readonly hostConfirmed: boolean;
      readonly mobileConfirmed: boolean;
      readonly transcriptHash: Uint8Array;
    }
  | { readonly kind: "completed"; readonly pairingId: PairingId; readonly routeId: RouteId }
  | { readonly kind: "expired"; readonly pairingId: PairingId };

export type PairingAction =
  | { readonly kind: "claim"; readonly transcriptHash: Uint8Array }
  | { readonly kind: "confirm-host"; readonly transcriptHash: Uint8Array }
  | { readonly kind: "confirm-mobile"; readonly transcriptHash: Uint8Array }
  | { readonly kind: "complete"; readonly routeId: RouteId }
  | { readonly kind: "expire" };

export function transitionPairing(
  state: PairingState,
  action: PairingAction,
  nowMs: bigint,
): PairingState {
  if (state.kind !== "completed" && state.kind !== "expired" && nowMs >= state.expiresAtMs) {
    return { kind: "expired", pairingId: state.pairingId };
  }
  if (state.kind === "awaiting-claim" && action.kind === "claim") {
    requireHash(action.transcriptHash);
    return {
      kind: "awaiting-confirmations",
      pairingId: state.pairingId,
      expiresAtMs: state.expiresAtMs,
      hostConfirmed: false,
      mobileConfirmed: false,
      transcriptHash: action.transcriptHash.slice(),
    };
  }
  if (state.kind === "awaiting-confirmations") {
    if (action.kind === "confirm-host" || action.kind === "confirm-mobile") {
      if (!constantTimeEqual(state.transcriptHash, action.transcriptHash)) {
        throw new ControlInvariantError("Pairing transcript mismatch");
      }
      return {
        ...state,
        hostConfirmed: state.hostConfirmed || action.kind === "confirm-host",
        mobileConfirmed: state.mobileConfirmed || action.kind === "confirm-mobile",
      };
    }
    if (action.kind === "complete") {
      if (!state.hostConfirmed || !state.mobileConfirmed) {
        throw new ControlInvariantError("Both confirmations are required");
      }
      return { kind: "completed", pairingId: state.pairingId, routeId: action.routeId };
    }
  }
  if (action.kind === "expire" && state.kind !== "completed") {
    return { kind: "expired", pairingId: state.pairingId };
  }
  throw new ControlInvariantError(`Invalid pairing transition ${state.kind} -> ${action.kind}`);
}

export interface RelayTicketClaims {
  readonly issuer: string;
  readonly audience: "pocket-omp-relay";
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
  readonly deviceKind: "HOST" | "MOBILE";
  readonly routeGrants: readonly RouteId[];
  readonly entitlement: "relay_pro";
  readonly credentialGeneration: bigint;
  readonly homeRegion: string;
  readonly relayOrigin: URL;
  readonly routeEpoch: bigint;
  readonly issuedAtSeconds: bigint;
  readonly expiresAtSeconds: bigint;
  readonly ticketId: string;
}

export interface EntitlementRepository {
  get(accountId: AccountId): Promise<EntitlementState | undefined>;
  applyEvent(accountId: AccountId, event: SubscriptionEvent): Promise<boolean>;
}

export interface RelayTicketSigner {
  sign(claims: RelayTicketClaims): Promise<string>;
}

export interface ControlOutbox {
  append(event: {
    readonly eventId: string;
    readonly kind: string;
    readonly payload: unknown;
  }): Promise<void>;
}

export interface Clock {
  nowMs(): bigint;
}

export class ControlInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ControlInvariantError";
  }
}

function requireHash(hash: Uint8Array): void {
  if (hash.byteLength !== 32) throw new ControlInvariantError("Expected SHA-256 hash");
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export type HostId = Brand<string, "HostId">;
export type CredentialGeneration = Brand<bigint, "CredentialGeneration">;

export function accountId(value: string): AccountId {
  return identifier(value, "AccountId");
}

export function deviceId(value: string): DeviceId {
  return identifier(value, "DeviceId");
}

export function pairingId(value: string): PairingId {
  return identifier(value, "PairingId");
}

export function routeId(value: string): RouteId {
  return identifier(value, "RouteId");
}

export interface VerifiedIdentity {
  readonly provider: "apple" | "google" | "email";
  readonly subject: string;
  readonly email?: string;
}

export interface Account {
  readonly accountId: AccountId;
  readonly status: "active" | "disabled" | "deleted";
  readonly createdAtMs: bigint;
}

export interface Device {
  readonly deviceId: DeviceId;
  readonly accountId: AccountId;
  readonly kind: "HOST" | "MOBILE";
  readonly name: string;
  readonly publicKey: Uint8Array;
  readonly credentialGeneration: bigint;
  readonly revokedAtMs?: bigint;
  readonly lastSeenAtMs: bigint;
}

export interface RegionRoute {
  readonly routeId: RouteId;
  readonly accountId: AccountId;
  readonly hostDeviceId: DeviceId;
  readonly mobileDeviceId: DeviceId;
  readonly homeRegion: string;
  readonly standbyRegion: string;
  readonly relayOrigin: URL;
  readonly routeEpoch: bigint;
  readonly frozen: boolean;
}

export interface AccountRepository {
  findOrCreate(identity: VerifiedIdentity, accountId: AccountId, nowMs: bigint): Promise<Account>;
  get(accountId: AccountId): Promise<Account | undefined>;
}

export interface DeviceRepository {
  create(device: Device, credentialHash: string): Promise<void>;
  get(deviceId: DeviceId): Promise<Device | undefined>;
  list(accountId: AccountId): Promise<readonly Device[]>;
  revoke(accountId: AccountId, deviceId: DeviceId, nowMs: bigint): Promise<bigint>;
}

export interface RegionRouteRepository {
  listForDevice(accountId: AccountId, deviceId: DeviceId): Promise<readonly RegionRoute[]>;
  create(route: RegionRoute): Promise<void>;
  promote(
    routeId: RouteId,
    expectedEpoch: bigint,
    homeRegion: string,
    standbyRegion: string,
  ): Promise<RegionRoute>;
}

export interface IdGenerator {
  newId(): string;
}

export interface CredentialHasher {
  hash(credential: string): Promise<string>;
}

export interface DeviceRegistration {
  readonly accountId: AccountId;
  readonly kind: Device["kind"];
  readonly name: string;
  readonly publicKey: Uint8Array;
}

export class ControlApplication {
  public constructor(
    private readonly accounts: AccountRepository,
    private readonly devices: DeviceRepository,
    private readonly routes: RegionRouteRepository,
    private readonly entitlements: EntitlementRepository,
    private readonly ticketSigner: RelayTicketSigner,
    private readonly credentialHasher: CredentialHasher,
    private readonly outbox: ControlOutbox,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly ticketIssuer: string,
  ) {}

  public async authenticate(identity: VerifiedIdentity): Promise<Account> {
    requireIdentity(identity);
    return this.accounts.findOrCreate(identity, accountId(this.ids.newId()), this.clock.nowMs());
  }

  public async registerDevice(
    registration: DeviceRegistration,
  ): Promise<{ readonly device: Device; readonly credential: string }> {
    const account = await this.accounts.get(registration.accountId);
    if (account?.status !== "active") throw new ControlInvariantError("Account is not active");
    if (registration.name.trim().length === 0 || registration.name.length > 128) {
      throw new ControlInvariantError("Invalid device name");
    }
    if (registration.publicKey.byteLength !== 32)
      throw new ControlInvariantError("Invalid device public key");
    const id = deviceId(this.ids.newId());
    const credential = `${this.ids.newId()}${this.ids.newId()}`;
    const device: Device = {
      deviceId: id,
      accountId: registration.accountId,
      kind: registration.kind,
      name: registration.name.trim(),
      publicKey: registration.publicKey.slice(),
      credentialGeneration: 1n,
      lastSeenAtMs: this.clock.nowMs(),
    };
    await this.devices.create(device, await this.credentialHasher.hash(credential));
    await this.outbox.append({
      eventId: this.ids.newId(),
      kind: "DeviceRegistered",
      payload: { accountId: registration.accountId, deviceId: id, kind: registration.kind },
    });
    return { device, credential };
  }

  public async revokeDevice(account: AccountId, id: DeviceId): Promise<bigint> {
    const generation = await this.devices.revoke(account, id, this.clock.nowMs());
    await this.outbox.append({
      eventId: this.ids.newId(),
      kind: "DeviceRevoked",
      payload: { accountId: account, deviceId: id, credentialGeneration: generation.toString() },
    });
    return generation;
  }

  public async issueRelayTicket(
    account: AccountId,
    id: DeviceId,
    requestedRoutes: readonly RouteId[],
  ): Promise<{ readonly ticket: string; readonly claims: RelayTicketClaims }> {
    const [device, entitlement, availableRoutes] = await Promise.all([
      this.devices.get(id),
      this.entitlements.get(account),
      this.routes.listForDevice(account, id),
    ]);
    if (device?.accountId !== account || device.revokedAtMs !== undefined) {
      throw new ControlInvariantError("Device is not authorized");
    }
    const nowMs = this.clock.nowMs();
    if (entitlement === undefined || !mayUseRelay(entitlement, nowMs)) {
      throw new ControlInvariantError("Relay entitlement is required");
    }
    const availableById = new Map(availableRoutes.map((route) => [route.routeId, route]));
    const grants =
      requestedRoutes.length === 0
        ? availableRoutes.map((route) => route.routeId)
        : requestedRoutes;
    const firstGrant = grants[0];
    if (firstGrant === undefined || grants.some((grant) => !availableById.has(grant))) {
      throw new ControlInvariantError("Invalid route grant");
    }
    const selected = availableById.get(firstGrant);
    if (selected === undefined || selected.frozen)
      throw new ControlInvariantError("Route is unavailable");
    if (
      grants.some((grant) => {
        const route = availableById.get(grant);
        return (
          route?.homeRegion !== selected.homeRegion || route.routeEpoch !== selected.routeEpoch
        );
      })
    ) {
      throw new ControlInvariantError("Route grants must share an active region epoch");
    }
    const issuedAtSeconds = nowMs / 1000n;
    const claims: RelayTicketClaims = {
      issuer: this.ticketIssuer,
      audience: "pocket-omp-relay",
      accountId: account,
      deviceId: id,
      deviceKind: device.kind,
      routeGrants: [...new Set(grants)],
      entitlement: "relay_pro",
      credentialGeneration: device.credentialGeneration,
      homeRegion: selected.homeRegion,
      relayOrigin: selected.relayOrigin,
      routeEpoch: selected.routeEpoch,
      issuedAtSeconds,
      expiresAtSeconds: issuedAtSeconds + 600n,
      ticketId: this.ids.newId(),
    };
    return { ticket: await this.ticketSigner.sign(claims), claims };
  }
}

function requireIdentity(identity: VerifiedIdentity): void {
  if (identity.subject.length === 0 || identity.subject.length > 512) {
    throw new ControlInvariantError("Invalid identity subject");
  }
  if (
    identity.email !== undefined &&
    (identity.email.length > 320 || !identity.email.includes("@"))
  ) {
    throw new ControlInvariantError("Invalid identity email");
  }
}

export interface PairingRecord {
  readonly state: PairingState;
  readonly hostName: string;
  readonly hostPublicKey: Uint8Array;
  readonly challengeHash: Uint8Array;
  readonly watchSecretHash: string;
  readonly accountId?: AccountId;
  readonly hostDeviceId?: DeviceId;
  readonly mobileDeviceId?: DeviceId;
  readonly mobilePublicKey?: Uint8Array;
}

export interface PairingRepository {
  create(record: PairingRecord): Promise<void>;
  get(id: PairingId): Promise<PairingRecord | undefined>;
  save(record: PairingRecord, expectedKind: PairingState["kind"]): Promise<void>;
  complete(record: PairingRecord, route: RegionRoute): Promise<void>;
}

export interface PairingSecrets {
  randomBytes(length: number): Uint8Array;
  hashBytes(value: Uint8Array): Uint8Array;
  hashOpaque(value: string): Promise<string>;
  verifyOpaque(value: string, hash: string): Promise<boolean>;
}

export interface PairingConfiguration {
  readonly serviceIdentifier: string;
  readonly homeRegion: string;
  readonly standbyRegion: string;
  readonly relayOrigin: URL;
  readonly lifetimeMs: bigint;
}

export class PairingApplication {
  public constructor(
    private readonly pairings: PairingRepository,
    private readonly secrets: PairingSecrets,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly configuration: PairingConfiguration,
  ) {}

  public async begin(
    hostName: string,
    hostPublicKey: Uint8Array,
  ): Promise<{
    readonly pairingId: PairingId;
    readonly challenge: Uint8Array;
    readonly watchSecret: string;
    readonly expiresAtMs: bigint;
    readonly serviceIdentifier: string;
  }> {
    if (hostName.trim().length === 0 || hostName.length > 128 || hostPublicKey.byteLength !== 32) {
      throw new ControlInvariantError("Invalid host pairing request");
    }
    const id = pairingId(this.ids.newId());
    const challenge = this.secrets.randomBytes(32);
    const watchSecret = `${this.ids.newId()}${this.ids.newId()}`;
    const expiresAtMs = this.clock.nowMs() + this.configuration.lifetimeMs;
    await this.pairings.create({
      state: {
        kind: "awaiting-claim",
        pairingId: id,
        expiresAtMs,
        challengeHash: this.secrets.hashBytes(challenge),
      },
      hostName: hostName.trim(),
      hostPublicKey: hostPublicKey.slice(),
      challengeHash: this.secrets.hashBytes(challenge),
      watchSecretHash: await this.secrets.hashOpaque(watchSecret),
    });
    return {
      pairingId: id,
      challenge,
      watchSecret,
      expiresAtMs,
      serviceIdentifier: this.configuration.serviceIdentifier,
    };
  }

  public async claim(input: {
    readonly pairingId: PairingId;
    readonly accountId: AccountId;
    readonly mobileDeviceId: DeviceId;
    readonly mobilePublicKey: Uint8Array;
    readonly challenge: Uint8Array;
    readonly transcriptHash: Uint8Array;
  }): Promise<PairingRecord> {
    const record = await this.requireActive(input.pairingId);
    if (record.state.kind !== "awaiting-claim")
      throw new ControlInvariantError("Pairing is not claimable");
    if (
      input.mobilePublicKey.byteLength !== 32 ||
      !constantTimeEqual(record.challengeHash, this.secrets.hashBytes(input.challenge))
    ) {
      throw new ControlInvariantError("Invalid pairing challenge");
    }
    const state = transitionPairing(
      record.state,
      { kind: "claim", transcriptHash: input.transcriptHash },
      this.clock.nowMs(),
    );
    const claimed: PairingRecord = {
      ...record,
      state,
      accountId: input.accountId,
      mobileDeviceId: input.mobileDeviceId,
      mobilePublicKey: input.mobilePublicKey.slice(),
    };
    await this.pairings.save(claimed, "awaiting-claim");
    return claimed;
  }

  public async confirm(
    id: PairingId,
    actor: "host" | "mobile",
    transcriptHash: Uint8Array,
  ): Promise<PairingRecord> {
    const record = await this.requireActive(id);
    if (record.state.kind !== "awaiting-confirmations")
      throw new ControlInvariantError("Pairing is not awaiting confirmation");
    const action: PairingAction =
      actor === "host"
        ? { kind: "confirm-host", transcriptHash }
        : { kind: "confirm-mobile", transcriptHash };
    const confirmed = {
      ...record,
      state: transitionPairing(record.state, action, this.clock.nowMs()),
    };
    await this.pairings.save(confirmed, "awaiting-confirmations");
    return confirmed;
  }

  public async complete(id: PairingId, hostDeviceId: DeviceId): Promise<RegionRoute> {
    const record = await this.requireActive(id);
    if (
      record.state.kind !== "awaiting-confirmations" ||
      record.accountId === undefined ||
      record.mobileDeviceId === undefined
    ) {
      throw new ControlInvariantError("Pairing is incomplete");
    }
    const route: RegionRoute = {
      routeId: routeId(this.ids.newId()),
      accountId: record.accountId,
      hostDeviceId,
      mobileDeviceId: record.mobileDeviceId,
      homeRegion: this.configuration.homeRegion,
      standbyRegion: this.configuration.standbyRegion,
      relayOrigin: this.configuration.relayOrigin,
      routeEpoch: 1n,
      frozen: false,
    };
    const completed = {
      ...record,
      hostDeviceId,
      state: transitionPairing(
        record.state,
        { kind: "complete", routeId: route.routeId },
        this.clock.nowMs(),
      ),
    };
    await this.pairings.complete(completed, route);
    return route;
  }

  public async authenticateWatcher(id: PairingId, watchSecret: string): Promise<PairingRecord> {
    const record = await this.requireActive(id);
    if (!(await this.secrets.verifyOpaque(watchSecret, record.watchSecretHash))) {
      throw new ControlInvariantError("Invalid pairing watch secret");
    }
    return record;
  }

  private async requireActive(id: PairingId): Promise<PairingRecord> {
    const record = await this.pairings.get(id);
    if (record === undefined) throw new ControlInvariantError("Pairing not found");
    if (
      record.state.kind !== "completed" &&
      record.state.kind !== "expired" &&
      this.clock.nowMs() >= record.state.expiresAtMs
    ) {
      const expired = {
        ...record,
        state: transitionPairing(record.state, { kind: "expire" }, this.clock.nowMs()),
      };
      await this.pairings.save(expired, record.state.kind);
      return expired;
    }
    return record;
  }
}

export interface ProtectedSecret {
  readonly keyId: string;
  readonly ciphertext: Uint8Array;
}

export interface SecretProtector {
  hash(value: string): Uint8Array;
  encrypt(value: string): Promise<ProtectedSecret>;
  decrypt(value: ProtectedSecret): Promise<string>;
}

export interface PushToken {
  readonly registrationId: string;
  readonly accountId: AccountId;
  readonly deviceId: DeviceId;
  readonly provider: "expo" | "apns" | "fcm";
  readonly protectedToken: ProtectedSecret;
}

export interface PushTokenRepository {
  upsert(token: PushToken, tokenHash: Uint8Array): Promise<string>;
  listActive(deviceId: DeviceId): Promise<readonly PushToken[]>;
}

export interface PushGateway {
  send(token: string, payload: { readonly kind: "WAKE"; readonly wakeId: string }): Promise<void>;
}

export class PushApplication {
  public constructor(
    private readonly devices: DeviceRepository,
    private readonly tokens: PushTokenRepository,
    private readonly protector: SecretProtector,
    private readonly gateway: PushGateway,
    private readonly ids: IdGenerator,
  ) {}

  public async register(
    account: AccountId,
    id: DeviceId,
    provider: PushToken["provider"],
    token: string,
  ): Promise<string> {
    const device = await this.devices.get(id);
    if (device?.accountId !== account || device.revokedAtMs !== undefined)
      throw new ControlInvariantError("Device is not authorized");
    if (token.length < 16 || token.length > 4096)
      throw new ControlInvariantError("Invalid push token");
    const registrationId = this.ids.newId();
    return this.tokens.upsert(
      {
        registrationId,
        accountId: account,
        deviceId: id,
        provider,
        protectedToken: await this.protector.encrypt(token),
      },
      this.protector.hash(token),
    );
  }

  public async sendWake(id: DeviceId, wakeId: string): Promise<number> {
    if (wakeId.length === 0 || wakeId.length > 128)
      throw new ControlInvariantError("Invalid wake identifier");
    const tokens = await this.tokens.listActive(id);
    await Promise.all(
      tokens.map(async (token) => {
        await this.gateway.send(await this.protector.decrypt(token.protectedToken), {
          kind: "WAKE",
          wakeId,
        });
      }),
    );
    return tokens.length;
  }
}

export interface PushWorkItem {
  readonly eventId: string;
  readonly deviceId: DeviceId;
  readonly wakeId: string;
}

export interface PushWorkQueue {
  lease(owner: string, nowMs: bigint, limit: number): Promise<readonly PushWorkItem[]>;
  complete(eventId: string, owner: string, nowMs: bigint): Promise<void>;
  retry(eventId: string, owner: string, errorCode: string): Promise<void>;
}

export class PushWorker {
  public constructor(
    private readonly queue: PushWorkQueue,
    private readonly push: PushApplication,
    private readonly clock: Clock,
    private readonly owner: string,
  ) {}

  public async runOnce(
    limit = 32,
  ): Promise<{ readonly completed: number; readonly failed: number }> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 128)
      throw new ControlInvariantError("Invalid worker batch limit");
    const work = await this.queue.lease(this.owner, this.clock.nowMs(), limit);
    const results = await Promise.all(
      work.map(async (item) => {
        try {
          await this.push.sendWake(item.deviceId, item.wakeId);
          await this.queue.complete(item.eventId, this.owner, this.clock.nowMs());
          return true;
        } catch {
          await this.queue.retry(item.eventId, this.owner, "PUSH_DELIVERY_FAILED");
          return false;
        }
      }),
    );
    return {
      completed: results.filter(Boolean).length,
      failed: results.filter((completed) => !completed).length,
    };
  }
}

export interface Attachment {
  readonly objectId: string;
  readonly accountId: AccountId;
  readonly ciphertextSize: bigint;
  readonly ciphertextHash: Uint8Array;
  readonly storageRegion: string;
  readonly status: "pending" | "available" | "deleted" | "expired";
  readonly expiresAtMs: bigint;
}

export interface AttachmentRepository {
  create(attachment: Attachment): Promise<void>;
  get(objectId: string): Promise<Attachment | undefined>;
}

export interface ObjectStorageGateway {
  createUpload(
    objectId: string,
    ciphertextSize: bigint,
    ciphertextHash: Uint8Array,
    expiresAtMs: bigint,
  ): Promise<{
    readonly url: URL;
    readonly requiredHeaders: Readonly<Record<string, string>>;
    readonly storageRegion: string;
  }>;
  createDownload(
    objectId: string,
    expiresAtMs: bigint,
  ): Promise<{
    readonly url: URL;
    readonly requiredHeaders: Readonly<Record<string, string>>;
  }>;
}

export class AttachmentApplication {
  public constructor(
    private readonly attachments: AttachmentRepository,
    private readonly storage: ObjectStorageGateway,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  public async createUpload(
    account: AccountId,
    ciphertextSize: bigint,
    ciphertextHash: Uint8Array,
    expiresAtMs: bigint,
  ): Promise<{
    readonly objectId: string;
    readonly uploadUrl: URL;
    readonly requiredHeaders: Readonly<Record<string, string>>;
  }> {
    if (
      ciphertextSize <= 0n ||
      ciphertextSize > 512n * 1024n * 1024n ||
      ciphertextHash.byteLength !== 32
    ) {
      throw new ControlInvariantError("Invalid attachment");
    }
    const now = this.clock.nowMs();
    if (expiresAtMs <= now || expiresAtMs > now + 7n * 86_400_000n)
      throw new ControlInvariantError("Invalid attachment expiry");
    const objectId = this.ids.newId();
    const upload = await this.storage.createUpload(
      objectId,
      ciphertextSize,
      ciphertextHash,
      expiresAtMs,
    );
    await this.attachments.create({
      objectId,
      accountId: account,
      ciphertextSize,
      ciphertextHash: ciphertextHash.slice(),
      storageRegion: upload.storageRegion,
      status: "pending",
      expiresAtMs,
    });
    return { objectId, uploadUrl: upload.url, requiredHeaders: upload.requiredHeaders };
  }

  public async createDownload(
    account: AccountId,
    objectId: string,
  ): Promise<{
    readonly downloadUrl: URL;
    readonly requiredHeaders: Readonly<Record<string, string>>;
  }> {
    const attachment = await this.attachments.get(objectId);
    if (
      attachment?.accountId !== account ||
      attachment.status !== "available" ||
      attachment.expiresAtMs <= this.clock.nowMs()
    ) {
      throw new ControlInvariantError("Attachment is unavailable");
    }
    const download = await this.storage.createDownload(objectId, this.clock.nowMs() + 300_000n);
    return { downloadUrl: download.url, requiredHeaders: download.requiredHeaders };
  }
}

export type AdminRole = "support-read" | "support-write" | "billing-admin" | "security-admin";

export interface AdminPrincipal {
  readonly staffSubject: string;
  readonly roles: ReadonlySet<AdminRole>;
  readonly authenticatedAtMs: bigint;
  readonly stepUpAtMs?: bigint;
}

export interface AdminAuthorizationRepository {
  hasActiveGrant(
    staffSubject: string,
    accountId: AccountId,
    grantId: string,
    requiredRole: AdminRole,
    nowMs: bigint,
  ): Promise<boolean>;
}

export interface AdminAuditRepository {
  append(event: {
    readonly eventId: string;
    readonly staffSubject: string;
    readonly action: string;
    readonly accountId?: AccountId;
    readonly targetId?: string;
    readonly correlationId: string;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void>;
}

export interface RelayDiagnosticsReader {
  getDeliveryMetadata(deviceId: DeviceId): Promise<{
    readonly queueCount: bigint;
    readonly queueBytes: bigint;
    readonly ackLag: bigint;
    readonly homeRegion: string;
    readonly routeEpoch: bigint;
  }>;
}

export class AdminApplication {
  public constructor(
    private readonly authorization: AdminAuthorizationRepository,
    private readonly audit: AdminAuditRepository,
    private readonly accounts: AccountRepository,
    private readonly devices: DeviceRepository,
    private readonly entitlements: EntitlementRepository,
    private readonly diagnostics: RelayDiagnosticsReader,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  public async getAccountDiagnostics(
    principal: AdminPrincipal,
    account: AccountId,
    grantId: string,
    correlationId: string,
  ): Promise<{
    readonly entitlement?: EntitlementState;
    readonly devices: readonly Device[];
    readonly delivery: readonly {
      readonly deviceId: DeviceId;
      readonly queueCount: bigint;
      readonly queueBytes: bigint;
      readonly ackLag: bigint;
      readonly homeRegion: string;
      readonly routeEpoch: bigint;
    }[];
  }> {
    await this.authorize(principal, account, grantId, "support-read", false, correlationId);
    const [accountRecord, entitlement, devices] = await Promise.all([
      this.accounts.get(account),
      this.entitlements.get(account),
      this.devices.list(account),
    ]);
    if (accountRecord === undefined) throw new ControlInvariantError("Account not found");
    const delivery = await Promise.all(
      devices.map(async (device) => ({
        deviceId: device.deviceId,
        ...(await this.diagnostics.getDeliveryMetadata(device.deviceId)),
      })),
    );
    await this.audit.append({
      eventId: this.ids.newId(),
      staffSubject: principal.staffSubject,
      action: "GetAccountDiagnostics",
      accountId: account,
      correlationId,
      metadata: { deviceCount: devices.length },
    });
    return { ...(entitlement === undefined ? {} : { entitlement }), devices, delivery };
  }

  public async revokeDevice(
    principal: AdminPrincipal,
    account: AccountId,
    device: DeviceId,
    grantId: string,
    correlationId: string,
  ): Promise<void> {
    await this.authorize(principal, account, grantId, "support-write", true, correlationId);
    await this.devices.revoke(account, device, this.clock.nowMs());
    await this.audit.append({
      eventId: this.ids.newId(),
      staffSubject: principal.staffSubject,
      action: "RevokeDeviceAsSupport",
      accountId: account,
      targetId: device,
      correlationId,
      metadata: {},
    });
  }

  private async authorize(
    principal: AdminPrincipal,
    account: AccountId,
    grantId: string,
    requiredRole: AdminRole,
    requireStepUp: boolean,
    correlationId: string,
  ): Promise<void> {
    const now = this.clock.nowMs();
    const stepUpValid =
      !requireStepUp ||
      (principal.stepUpAtMs !== undefined &&
        principal.stepUpAtMs <= now &&
        now - principal.stepUpAtMs <= 300_000n);
    const allowed =
      principal.staffSubject.length > 0 &&
      principal.roles.has(requiredRole) &&
      stepUpValid &&
      (await this.authorization.hasActiveGrant(
        principal.staffSubject,
        account,
        grantId,
        requiredRole,
        now,
      ));
    if (!allowed) {
      await this.audit.append({
        eventId: this.ids.newId(),
        staffSubject: principal.staffSubject || "unknown",
        action: "AdminAccessDenied",
        accountId: account,
        correlationId,
        metadata: { requiredRole, requireStepUp },
      });
      throw new ControlInvariantError("Admin access denied");
    }
  }
}

function identifier<Name extends string>(value: string, name: Name): Brand<string, Name> {
  if (value.length === 0 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new ControlInvariantError(`Invalid ${name}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validation is the brand constructor
  return value as Brand<string, Name>;
}

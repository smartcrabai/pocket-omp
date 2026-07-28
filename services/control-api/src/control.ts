import { importJWK, SignJWT, createRemoteJWKSet, jwtVerify, type JWK } from "jose";
import {
  ControlInvariantError,
  mayUseRelay,
  accountId,
  deviceId,
  type Account,
  type EntitlementState,
  type VerifiedIdentity,
} from "@pocket-omp/control-core";
import type { AdminControl, PairingRecord, RouteRecord } from "./admin";

const PAIRING_LIFETIME_MS = 5n * 60_000n;
const TICKET_LIFETIME_SECONDS = 600n;
const AUTO_GRANT_YEARS_MS = 100n * 365n * 86_400_000n;
const DEVICE_CREDENTIAL_PREFIX = "poc_dev_";

export interface ControlPlane {
  readonly store: DurableObjectStub<AdminControl>;
  readonly env: ControlEnv;
}

// RELAY_SIGNING_PRIVATE_KEY is a Wrangler secret and is therefore absent from
// the generated Env type.
export type ControlEnv = Env & {
  readonly RELAY_SIGNING_PRIVATE_KEY?: string;
};

export function createControlPlane(env: Env): ControlPlane {
  return { store: env.ADMIN_CONTROL.getByName("control"), env };
}

export async function beginPairing(request: Request, plane: ControlPlane): Promise<Response> {
  const body = await jsonBody(request);
  const hostName = stringField(body, "host_name");
  const hostPublicKey = hexField(body, "host_public_key", 32);
  const now = BigInt(Date.now());
  const pairingId = crypto.randomUUID();
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const watchSecret =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const record: PairingRecord = {
    pairingId,
    hostName,
    hostPublicKey,
    challengeHash: await sha256(challenge),
    watchSecretHash: await sha256Hex(watchSecret),
    state: "awaiting-claim",
    hostConfirmed: false,
    mobileConfirmed: false,
    expiresAtMs: now + PAIRING_LIFETIME_MS,
    createdAtMs: now,
  };
  await plane.store.createPairing(record);
  return Response.json({
    pairing_id: pairingId,
    challenge: hex(challenge),
    watch_secret: watchSecret,
    expires_at_ms: Number(record.expiresAtMs),
    service_identifier: plane.env.SERVICE_IDENTIFIER ?? "pocket-omp",
  });
}

export async function watchPairing(
  request: Request,
  plane: ControlPlane,
  pairingId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const watchSecret = url.searchParams.get("watch_secret");
  if (watchSecret === null || watchSecret.length === 0)
    throw new ControlInvariantError("watch_secret is required");
  const pairing = await requirePairing(plane, pairingId);
  if (pairing.watchSecretHash !== (await sha256Hex(watchSecret)))
    throw new ControlInvariantError("Invalid pairing watch secret");
  return Response.json(pairingView(pairing));
}

export async function claimPairing(
  request: Request,
  plane: ControlPlane,
  pairingId: string,
): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  const body = await jsonBody(request);
  const mobilePublicKey = hexField(body, "mobile_public_key", 32);
  const mobileName = optionalStringField(body, "mobile_name") ?? "Mobile";
  const pairing = await requirePairing(plane, pairingId);
  if (pairing.state !== "awaiting-claim")
    throw new ControlInvariantError("Pairing is not claimable");

  const account = await findOrCreateAccount(plane, identity);
  const now = BigInt(Date.now());
  const mobileDeviceId = crypto.randomUUID();
  const mobileCredential = newDeviceCredential();
  await plane.store.createDevice(
    {
      deviceId: deviceId(mobileDeviceId),
      accountId: account.accountId,
      kind: "MOBILE",
      name: mobileName,
      publicKey: mobilePublicKey,
      credentialGeneration: 1n,
      lastSeenAtMs: now,
    },
    await sha256Hex(mobileCredential),
  );
  const route: RouteRecord = {
    routeId: crypto.randomUUID(),
    accountId: account.accountId,
    mobileDeviceId,
    homeRegion: "cloudflare",
    standbyRegion: "cloudflare",
    relayOrigin: relayOrigin(plane.env),
    routeEpoch: 1n,
    frozen: false,
    createdAtMs: now,
  };
  await plane.store.createRoute(route);
  await plane.store.savePairing({
    ...pairing,
    state: "awaiting-confirmations",
    accountId: account.accountId,
    mobileDeviceId,
    mobilePublicKey,
    routeId: route.routeId,
  });
  return Response.json({
    route_id: route.routeId,
    device_id: mobileDeviceId,
    device_credential: mobileCredential,
    expires_at_ms: Number(pairing.expiresAtMs),
  });
}

export async function completePairing(
  request: Request,
  plane: ControlPlane,
  pairingId: string,
): Promise<Response> {
  const body = await jsonBody(request);
  const actor = stringField(body, "actor");
  if (actor !== "host" && actor !== "mobile") throw new ControlInvariantError("Invalid actor");
  const pairing = await requirePairing(plane, pairingId);
  if (pairing.state !== "awaiting-confirmations")
    throw new ControlInvariantError("Pairing is not awaiting confirmation");

  if (actor === "host") {
    const watchSecret = stringField(body, "watch_secret");
    if (pairing.watchSecretHash !== (await sha256Hex(watchSecret)))
      throw new ControlInvariantError("Invalid pairing watch secret");
    if (pairing.accountId === undefined || pairing.routeId === undefined)
      throw new ControlInvariantError("Pairing is not claimed");
    const now = BigInt(Date.now());
    const hostDeviceId = crypto.randomUUID();
    const hostCredential = newDeviceCredential();
    await plane.store.createDevice(
      {
        deviceId: deviceId(hostDeviceId),
        accountId: accountId(pairing.accountId),
        kind: "HOST",
        name: pairing.hostName,
        publicKey: pairing.hostPublicKey,
        credentialGeneration: 1n,
        lastSeenAtMs: now,
      },
      await sha256Hex(hostCredential),
    );
    await plane.store.attachHostToRoute(pairing.routeId, hostDeviceId);
    await plane.store.savePairing({
      ...pairing,
      state: pairing.mobileConfirmed ? "completed" : "awaiting-confirmations",
      hostDeviceId,
      hostConfirmed: true,
    });
    return Response.json({
      host_id: hostDeviceId,
      route_id: pairing.routeId,
      device_credential: hostCredential,
      state: pairing.mobileConfirmed ? "completed" : "awaiting-confirmations",
    });
  }

  const identity = await authenticateUser(request, plane.env);
  const account = await findOrCreateAccount(plane, identity);
  if (pairing.accountId !== account.accountId)
    throw new ControlInvariantError("Pairing belongs to a different account");
  await plane.store.savePairing({
    ...pairing,
    state: pairing.hostConfirmed ? "completed" : "awaiting-confirmations",
    mobileConfirmed: true,
  });
  return Response.json({ state: pairing.hostConfirmed ? "completed" : "awaiting-confirmations" });
}

export async function deleteRoute(
  request: Request,
  plane: ControlPlane,
  routeId: string,
): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  const account = await findOrCreateAccount(plane, identity);
  const route = await plane.store.getRoute(routeId);
  if (route === undefined || route.accountId !== account.accountId)
    throw new ControlInvariantError("Route not found");
  await plane.store.freezeRoute(routeId);
  if (route.hostDeviceId !== undefined)
    await plane.store.revokeDevice(
      account.accountId,
      deviceId(route.hostDeviceId),
      BigInt(Date.now()),
    );
  return new Response(null, { status: 204 });
}

export async function listDevices(request: Request, plane: ControlPlane): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  const account = await findOrCreateAccount(plane, identity);
  const devices = await plane.store.listDevices(account.accountId);
  return Response.json({
    devices: devices.map((device) => ({
      device_id: device.deviceId,
      name: device.name,
      kind: device.kind,
      last_seen_at_ms: Number(device.lastSeenAtMs),
      revoked: device.revokedAtMs !== undefined,
    })),
  });
}

export async function renameDevice(
  request: Request,
  plane: ControlPlane,
  targetDeviceId: string,
): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  const body = await jsonBody(request);
  const name = stringField(body, "name");
  if (name.trim().length === 0 || name.length > 128)
    throw new ControlInvariantError("Invalid device name");
  const account = await findOrCreateAccount(plane, identity);
  const device = await plane.store.renameDevice(
    account.accountId,
    deviceId(targetDeviceId),
    name.trim(),
  );
  return Response.json({ device_id: device.deviceId, name: device.name, kind: device.kind });
}

export async function revokeDevice(
  request: Request,
  plane: ControlPlane,
  targetDeviceId: string,
): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  const account = await findOrCreateAccount(plane, identity);
  const generation = await plane.store.revokeDevice(
    account.accountId,
    deviceId(targetDeviceId),
    BigInt(Date.now()),
  );
  return Response.json({ credential_generation: generation.toString() });
}

export async function getEntitlement(request: Request, plane: ControlPlane): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  const account = await findOrCreateAccount(plane, identity);
  const entitlement = await ensureEntitlement(plane, account);
  return Response.json({
    entitlement: {
      product: "relay_pro",
      state: entitlement.kind,
      ...("usableUntilMs" in entitlement && entitlement.usableUntilMs !== undefined
        ? { usable_until_ms: Number(entitlement.usableUntilMs) }
        : {}),
      updated_at_ms: Date.now(),
    },
  });
}

export async function refreshEntitlement(request: Request, plane: ControlPlane): Promise<Response> {
  // RevenueCat reconciliation is a follow-up; for now this returns the current
  // state (auto-granting when ENTITLEMENT_AUTO_GRANT is enabled).
  return getEntitlement(request, plane);
}

export async function issueRelayTicket(request: Request, plane: ControlPlane): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith(`Bearer ${DEVICE_CREDENTIAL_PREFIX}`) !== true)
    throw new ControlInvariantError("Device credential is required");
  const credential = authorization.slice(7);
  const body = await jsonBody(request);
  const targetDeviceId = stringField(body, "device_id");
  const requestedRoutes = stringArrayField(body, "route_ids");

  const store = plane.store;
  if (!(await store.verifyDeviceCredential(deviceId(targetDeviceId), await sha256Hex(credential))))
    throw new ControlInvariantError("Device credential is invalid");
  const device = await store.getDevice(deviceId(targetDeviceId));
  if (device === undefined || device.revokedAtMs !== undefined)
    throw new ControlInvariantError("Device is not authorized");
  const account = await store.getAccount(device.accountId);
  if (account?.status !== "active") throw new ControlInvariantError("Account is not active");
  const entitlement = await ensureEntitlement(plane, account);
  if (!mayUseRelay(entitlement, BigInt(Date.now())))
    throw new ControlInvariantError("Relay entitlement is required");

  const available = await store.listRoutesForDevice(device.accountId, device.deviceId);
  const availableById = new Map(available.map((route) => [route.routeId, route]));
  const grantIds =
    requestedRoutes.length === 0 ? available.map((route) => route.routeId) : requestedRoutes;
  const firstId = grantIds[0];
  if (firstId === undefined || grantIds.some((id) => !availableById.has(id)))
    throw new ControlInvariantError("Invalid route grant");
  const selected = availableById.get(firstId);
  if (selected === undefined || selected.frozen)
    throw new ControlInvariantError("Route is unavailable");
  if (
    grantIds.some((id) => {
      const route = availableById.get(id);
      return route?.homeRegion !== selected.homeRegion || route.routeEpoch !== selected.routeEpoch;
    })
  )
    throw new ControlInvariantError("Route grants must share an active region epoch");

  const signingKey = await relaySigningKey(plane.env);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const ticket = await new SignJWT({
    account_id: device.accountId,
    device_id: device.deviceId,
    route_grants: [...new Set(grantIds)],
    entitlement: "relay_pro",
    credential_generation: device.credentialGeneration.toString(),
    home_region: selected.homeRegion,
    route_epoch: selected.routeEpoch.toString(),
  })
    .setProtectedHeader({ alg: "EdDSA", kid: signingKey.kid })
    .setIssuer(plane.env.RELAY_JWT_ISSUER)
    .setAudience("pocket-omp-relay")
    .setSubject(device.deviceId)
    .setJti(crypto.randomUUID())
    .setIssuedAt(Number(nowSeconds))
    .setExpirationTime(Number(nowSeconds + TICKET_LIFETIME_SECONDS))
    .sign(signingKey.privateKey);

  return Response.json({
    ticket,
    relay_origin: selected.relayOrigin,
    expires_at_ms: Number((nowSeconds + TICKET_LIFETIME_SECONDS) * 1000n),
    route_epoch: selected.routeEpoch.toString(),
  });
}

export async function relayJwks(plane: ControlPlane): Promise<Response> {
  const signingKey = await relaySigningKey(plane.env);
  return Response.json(
    { keys: [signingKey.publicJwk] },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}

export async function registerPushTokens(request: Request, plane: ControlPlane): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  const body = await jsonBody(request);
  const provider = stringField(body, "provider");
  if (provider !== "expo") throw new ControlInvariantError("Only expo push is supported");
  const token = stringField(body, "token");
  if (token.length < 16 || token.length > 4096)
    throw new ControlInvariantError("Invalid push token");
  const account = await findOrCreateAccount(plane, identity);
  const devices = await plane.store.listDevices(account.accountId);
  const mobileDevices = devices.filter(
    (device) => device.kind === "MOBILE" && device.revokedAtMs === undefined,
  );
  await Promise.all(
    mobileDevices.map((device) =>
      plane.env.RELAY_MAILBOX.getByName(device.deviceId).fetch(
        "https://mailbox.internal/push-registration",
        { method: "PUT", body: JSON.stringify({ expoPushToken: token }) },
      ),
    ),
  );
  return Response.json({ registration_id: crypto.randomUUID(), devices: mobileDevices.length });
}

export async function relayWake(
  request: Request,
  plane: ControlPlane,
  wakeId: string,
): Promise<Response> {
  await authenticateUser(request, plane.env);
  if (wakeId.length === 0 || wakeId.length > 128)
    throw new ControlInvariantError("Invalid wake identifier");
  return new Response(null, { status: 204 });
}

interface SigningKey {
  readonly privateKey: Awaited<ReturnType<typeof importJWK>>;
  readonly publicJwk: JWK;
  readonly kid: string;
}

let cachedSigningKey: Promise<SigningKey> | undefined;

function relaySigningKey(env: ControlEnv): Promise<SigningKey> {
  cachedSigningKey ??= loadSigningKey(env);
  return cachedSigningKey;
}

async function loadSigningKey(env: ControlEnv): Promise<SigningKey> {
  const secret = env.RELAY_SIGNING_PRIVATE_KEY;
  if (secret === undefined || secret.length === 0)
    throw new ControlInvariantError("RELAY_SIGNING_PRIVATE_KEY is not configured");
  // The secret is the base64url-encoded private JWK (which also carries the
  // public `x` coordinate). Workerd CryptoKeys are non-extractable, so the
  // public JWK is derived from the JSON rather than from the CryptoKey.
  const parsed: unknown = JSON.parse(atob(secret));
  if (!isJsonWebKey(parsed) || parsed.kty !== "OKP" || parsed.crv !== "Ed25519")
    throw new ControlInvariantError("RELAY_SIGNING_PRIVATE_KEY must be an Ed25519 private JWK");
  const jwk = parsed;
  if (typeof jwk.d !== "string" || typeof jwk.x !== "string")
    throw new ControlInvariantError("RELAY_SIGNING_PRIVATE_KEY must be an Ed25519 private JWK");
  const privateKey = await importJWK({ ...jwk, ext: true }, "EdDSA");
  const publicJwk: JWK = {
    kty: "OKP",
    crv: "Ed25519",
    x: jwk.x,
    kid: "relay-signing-1",
    alg: "EdDSA",
    use: "sig",
  };
  return { privateKey, publicJwk, kid: "relay-signing-1" };
}

function isJsonWebKey(value: unknown): value is JWK {
  return isRecordValue(value);
}

async function authenticateUser(request: Request, env: ControlEnv): Promise<VerifiedIdentity> {
  if (env.CONTROL_AUTH_DISABLED === "true") {
    const subject = request.headers.get("x-user-subject");
    if (subject === null || subject.length === 0)
      throw new ControlInvariantError("User subject is required");
    const email = request.headers.get("x-user-email") ?? undefined;
    return { provider: "email", subject, ...(email === undefined ? {} : { email }) };
  }
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ") !== true)
    throw new ControlInvariantError("Bearer token is required");
  try {
    const verified = await jwtVerify(
      authorization.slice(7),
      createRemoteJWKSet(new URL(env.OIDC_JWKS_URL)),
      {
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_AUDIENCE,
        algorithms: ["RS256"],
      },
    );
    if (typeof verified.payload.sub !== "string" || verified.payload.sub.length === 0)
      throw new Error("JWT subject required");
    const email = typeof verified.payload.email === "string" ? verified.payload.email : undefined;
    return {
      provider: "email",
      subject: verified.payload.sub,
      ...(email === undefined ? {} : { email }),
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "user_token_rejected",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new ControlInvariantError("User token is invalid");
  }
}

async function findOrCreateAccount(
  plane: ControlPlane,
  identity: VerifiedIdentity,
): Promise<Account> {
  if (identity.subject.length === 0 || identity.subject.length > 512)
    throw new ControlInvariantError("Invalid identity subject");
  const account = await plane.store.findOrCreateAccount(
    identity,
    accountId(crypto.randomUUID()),
    BigInt(Date.now()),
  );
  return account;
}

async function ensureEntitlement(plane: ControlPlane, account: Account): Promise<EntitlementState> {
  const existing = await plane.store.getEntitlement(account.accountId);
  if (existing !== undefined) return existing;
  if (plane.env.ENTITLEMENT_AUTO_GRANT !== "true")
    throw new ControlInvariantError("Relay entitlement is required");
  const granted: EntitlementState = {
    kind: "active",
    usableUntilMs: BigInt(Date.now()) + AUTO_GRANT_YEARS_MS,
  };
  await plane.store.saveEntitlementState(account.accountId, granted, BigInt(Date.now()));
  return granted;
}

async function requirePairing(plane: ControlPlane, id: string): Promise<PairingRecord> {
  const pairing = await plane.store.getPairing(id);
  if (pairing === undefined) throw new ControlInvariantError("Pairing not found");
  if (pairing.state !== "completed" && pairing.state !== "expired") {
    if (BigInt(Date.now()) >= pairing.expiresAtMs) {
      const expired = { ...pairing, state: "expired" as const };
      await plane.store.savePairing(expired);
      return expired;
    }
  }
  return pairing;
}

function pairingView(pairing: PairingRecord): Record<string, unknown> {
  return {
    pairing_id: pairing.pairingId,
    state: pairing.state,
    host_name: pairing.hostName,
    ...(pairing.mobilePublicKey === undefined
      ? {}
      : { mobile_public_key: hex(pairing.mobilePublicKey) }),
    ...(pairing.routeId === undefined ? {} : { route_id: pairing.routeId }),
    host_confirmed: pairing.hostConfirmed,
    mobile_confirmed: pairing.mobileConfirmed,
    expires_at_ms: Number(pairing.expiresAtMs),
  };
}

function relayOrigin(env: ControlEnv): string {
  return env.RELAY_ORIGIN ?? new URL(env.RELAY_JWKS_URL).origin;
}

function newDeviceCredential(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return DEVICE_CREDENTIAL_PREFIX + hex(bytes);
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", bytesBuffer(value));
  return new Uint8Array(digest);
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await sha256(new TextEncoder().encode(value)));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new ControlInvariantError("Invalid hex encoding");
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function bytesBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json();
  if (!isRecordValue(body)) throw new ControlInvariantError("Invalid request body");
  return body;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0)
    throw new ControlInvariantError(`${name} is required`);
  return value;
}

function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hexField(body: Record<string, unknown>, name: string, bytes: number): Uint8Array {
  const value = fromHex(stringField(body, name));
  if (value.byteLength !== bytes) throw new ControlInvariantError(`${name} must be ${bytes} bytes`);
  return value;
}

function stringArrayField(body: Record<string, unknown>, name: string): readonly string[] {
  const value = body[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new ControlInvariantError(`${name} must be a string array`);
  return value;
}

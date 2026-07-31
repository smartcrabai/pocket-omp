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
  await plane.store.deleteExpiredPairings(now);
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
  // The challenge proves QR possession: the pairing QR carries it and only a
  // scanner can present it back (restores the legacy claim-time check).
  const challenge = hexField(body, "challenge", 32);
  const mobileName = optionalStringField(body, "mobile_name") ?? "Mobile";

  const account = await findOrCreateAccount(plane, identity);
  const now = BigInt(Date.now());
  const mobileDeviceId = crypto.randomUUID();
  const mobileCredential = newDeviceCredential();
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
  const claimed = await plane.store.claimPairingTx(
    pairingId,
    await sha256(challenge),
    account.accountId,
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
    route,
  );
  return Response.json({
    route_id: route.routeId,
    device_id: mobileDeviceId,
    device_credential: mobileCredential,
    expires_at_ms: Number(claimed.expiresAtMs),
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

  if (actor === "host") {
    const watchSecret = stringField(body, "watch_secret");
    const pairing = await requirePairing(plane, pairingId);
    if (pairing.accountId === undefined) throw new ControlInvariantError("Pairing is not claimed");
    const now = BigInt(Date.now());
    const hostDeviceId = crypto.randomUUID();
    const hostCredential = newDeviceCredential();
    const confirmed = await plane.store.completePairingHostTx(
      pairingId,
      await sha256Hex(watchSecret),
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
    // claimPairingTx always sets mobileDeviceId on the record before this Tx
    // is reachable (completePairingHostTx requires pairing.routeId, which is
    // only set once claimed), so this is a defensive invariant check rather
    // than an expected runtime path.
    if (confirmed.mobileDeviceId === undefined)
      throw new ControlInvariantError("Pairing is missing its mobile device");
    return Response.json({
      host_id: hostDeviceId,
      route_id: confirmed.routeId,
      device_credential: hostCredential,
      state: confirmed.state,
      // Lets the Host learn its relay recipient at pairing time instead of
      // waiting to decrypt an inbound envelope (see
      // apps/host/src/recipient-device-id-learner.ts) or making a follow-up
      // round trip to GET .../recipient-device-id (below) right after pairing.
      recipient_device_id: confirmed.mobileDeviceId,
    });
  }

  const identity = await authenticateUser(request, plane.env);
  const account = await findOrCreateAccount(plane, identity);
  const confirmed = await plane.store.confirmPairingMobileTx(pairingId, account.accountId);
  return Response.json({ state: confirmed.state });
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
  const updatedAtMs = await plane.store.getEntitlementUpdatedAtMs(account.accountId);
  return Response.json({
    entitlement: {
      product: "relay_pro",
      state: entitlement.kind,
      ...("usableUntilMs" in entitlement && entitlement.usableUntilMs !== undefined
        ? { usable_until_ms: Number(entitlement.usableUntilMs) }
        : {}),
      updated_at_ms: Number(updatedAtMs ?? BigInt(Date.now())),
    },
  });
}

export async function refreshEntitlement(request: Request, plane: ControlPlane): Promise<Response> {
  // RevenueCat reconciliation is a follow-up; for now this returns the current
  // state (auto-granting when ENTITLEMENT_AUTO_GRANT is enabled).
  return getEntitlement(request, plane);
}

export async function issueRelayTicket(request: Request, plane: ControlPlane): Promise<Response> {
  const credential = deviceCredentialFromHeader(request);
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

// Lets an already-paired Host (or Mobile) look up the *other* end of its own
// route by device_id/device_credential alone -- the same bearer authority
// `issueRelayTicket` accepts -- instead of requiring the logged-in user's
// OIDC bearer token that `listDevices` needs. This is the fallback/recovery
// path for pairings that predate `completePairing`'s `recipient_device_id`
// field (or that lost track of it locally); most callers should already have
// learned it from that response and only need this for recovery.
//
// Authorization mirrors issueRelayTicket's device-credential checks exactly
// (credential-hash validity implies revoked_at_ms IS NULL; the redundant
// device.revokedAtMs check below matches issueRelayTicket line for line) and
// then additionally scopes the lookup to routes the caller's own device_id
// actually belongs to (as either the host or the mobile side, and never
// frozen/deleted), so a device can never enumerate another account's routes
// or devices -- ADR-018's least-privilege spirit applied to this boundary.
export async function getRouteRecipientDevice(
  request: Request,
  plane: ControlPlane,
  routeId: string,
): Promise<Response> {
  const credential = deviceCredentialFromHeader(request);
  const body = await jsonBody(request);
  const callerDeviceId = stringField(body, "device_id");

  const store = plane.store;
  if (!(await store.verifyDeviceCredential(deviceId(callerDeviceId), await sha256Hex(credential))))
    throw new ControlInvariantError("Device credential is invalid");
  const device = await store.getDevice(deviceId(callerDeviceId));
  if (device === undefined || device.revokedAtMs !== undefined)
    throw new ControlInvariantError("Device is not authorized");
  const account = await store.getAccount(device.accountId);
  if (account?.status !== "active") throw new ControlInvariantError("Account is not active");

  const route = await store.getRoute(routeId);
  if (
    route === undefined ||
    route.accountId !== device.accountId ||
    (route.hostDeviceId !== callerDeviceId && route.mobileDeviceId !== callerDeviceId)
  )
    // Deliberately the same message/status as "route truly does not exist"
    // -- a device probing other routeIds cannot distinguish "not yours" from
    // "never existed".
    throw new ControlInvariantError("Route not found");
  if (route.frozen) throw new ControlInvariantError("Route is unavailable");

  const recipientDeviceId =
    route.hostDeviceId === callerDeviceId ? route.mobileDeviceId : route.hostDeviceId;
  if (recipientDeviceId === undefined)
    throw new ControlInvariantError("Recipient device is not yet known");
  return Response.json({ recipient_device_id: recipientDeviceId });
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
  // Each mailbox must hold that device's own token. Without a device_id we
  // can only register safely when the account has exactly one active mobile
  // device; otherwise the caller must name the device so one phone's token
  // never lands in another phone's mailbox.
  const targetDeviceId = optionalStringField(body, "device_id");
  let targets = mobileDevices;
  if (targetDeviceId !== undefined) {
    const target = mobileDevices.find((device) => device.deviceId === targetDeviceId);
    if (target === undefined) throw new ControlInvariantError("Device is not authorized");
    targets = [target];
  } else if (mobileDevices.length > 1) {
    throw new ControlInvariantError("device_id is required for multi-device accounts");
  }
  await Promise.all(
    targets.map((device) =>
      plane.env.RELAY_MAILBOX.getByName(device.deviceId).fetch(
        "https://mailbox.internal/push-registration",
        { method: "PUT", body: JSON.stringify({ expoPushToken: token }) },
      ),
    ),
  );
  return Response.json({ registration_id: crypto.randomUUID(), devices: targets.length });
}

export async function relayWake(
  request: Request,
  plane: ControlPlane,
  wakeId: string,
): Promise<Response> {
  const identity = await authenticateUser(request, plane.env);
  if (wakeId.length === 0 || wakeId.length > 128)
    throw new ControlInvariantError("Invalid wake identifier");
  // Wake handling is client-side: the notification tap opens the app, which
  // reconnects its relay stream and catches up via the normal subscribe/ack
  // flow. This endpoint only authenticates the tap so stale/forged wake ids
  // cannot be used to probe account existence.
  await findOrCreateAccount(plane, identity);
  return new Response(null, { status: 204 });
}

interface SigningKey {
  readonly privateKey: Awaited<ReturnType<typeof importJWK>>;
  readonly publicJwk: JWK;
  readonly kid: string;
}

let cachedSigningKey: Promise<SigningKey> | undefined;

// Relay ticket verification keys derived from the Worker's own signing key.
// The Worker is both issuer and verifier, so verification uses the local key
// instead of an HTTP fetch to its own /.well-known/jwks.json endpoint (which
// fails when a Worker calls its own workers.dev URL from within itself).
export async function relayVerificationKeys(env: ControlEnv): Promise<{ keys: JWK[] }> {
  const signingKey = await relaySigningKey(env);
  return { keys: [signingKey.publicJwk] };
}

function relaySigningKey(env: ControlEnv): Promise<SigningKey> {
  cachedSigningKey ??= loadSigningKey(env);
  return cachedSigningKey;
}

async function loadSigningKey(env: ControlEnv): Promise<SigningKey> {
  const secret = env.RELAY_SIGNING_PRIVATE_KEY;
  if (secret === undefined || secret.length === 0)
    throw new ControlInvariantError("RELAY_SIGNING_PRIVATE_KEY is not configured");
  // The secret is the standard-base64-encoded private JWK (which also carries
  // the public `x` coordinate). Workerd CryptoKeys are non-extractable, so the
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

// Shared by issueRelayTicket and getRouteRecipientDevice: both authenticate
// solely via a device's own bearer credential (no user OIDC token / pairing
// watch_secret involved).
function deviceCredentialFromHeader(request: Request): string {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith(`Bearer ${DEVICE_CREDENTIAL_PREFIX}`) !== true)
    throw new ControlInvariantError("Device credential is required");
  return authorization.slice(7);
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
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ControlInvariantError("Request body must be valid JSON");
  }
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

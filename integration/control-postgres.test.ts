import { describe, expect, test } from "bun:test";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import {
  ControlApplication,
  AdminApplication,
  AttachmentApplication,
  PushApplication,
  PushWorker,
  PairingApplication,
  accountId,
  deviceId,
  routeId,
  applySubscriptionEvent,
  mayUseRelay,
  pairingId,
  transitionPairing,
  type CredentialHasher,
  type IdGenerator,
  type RelayTicketClaims,
  type ObjectStorageGateway,
  type RelayTicketSigner,
} from "@pocket-omp/control-core";
import {
  BunPairingSecrets,
  AesGcmSecretProtector,
  Ed25519RelayTicketSigner,
  RevenueCatWebhookVerifier,
  SystemClock,
  ExpoPushGateway,
  UuidV7Generator,
  PostgresAdminSecurity,
  hashCredential,
  verifyCredential,
  PostgresAccountRepository,
  PostgresControlOutbox,
  PostgresControlStore,
  PostgresDeviceRepository,
  PostgresEntitlementRepository,
  PostgresAttachmentRepository,
  PostgresPushTokenRepository,
  PostgresRegionRouteRepository,
  PostgresPushWorkQueue,
  PostgresPairingRepository,
} from "@pocket-omp/control-adapters";

class SequentialIds implements IdGenerator {
  private next = 0;
  public newId(): string {
    this.next += 1;
    return `test-${Date.now()}-${this.next}`;
  }
}

class FastHasher implements CredentialHasher {
  public async hash(credential: string): Promise<string> {
    return `hashed:${credential.length}`;
  }
}

class CapturingSigner implements RelayTicketSigner {
  public claims?: RelayTicketClaims;
  public async sign(claims: RelayTicketClaims): Promise<string> {
    this.claims = claims;
    return "signed-ticket";
  }
}

const databaseUrl =
  process.env.CONTROL_DATABASE_URL ?? "postgres://pocket:pocket-dev-only@127.0.0.1:55434/control";

test("pairing state machine rejects transcript substitution and requires both confirmations", () => {
  const hash = new Uint8Array(32).fill(7);
  const initial = {
    kind: "awaiting-claim" as const,
    pairingId: pairingId("pairing-1"),
    expiresAtMs: 2_000n,
    challengeHash: new Uint8Array(32).fill(1),
  };
  const claimed = transitionPairing(initial, { kind: "claim", transcriptHash: hash }, 1_000n);
  expect(() =>
    transitionPairing(
      claimed,
      { kind: "confirm-host", transcriptHash: new Uint8Array(32).fill(8) },
      1_000n,
    ),
  ).toThrow("Pairing transcript mismatch");
  const hostConfirmed = transitionPairing(
    claimed,
    { kind: "confirm-host", transcriptHash: hash },
    1_000n,
  );
  expect(() =>
    transitionPairing(hostConfirmed, { kind: "complete", routeId: routeId("route-1") }, 1_000n),
  ).toThrow("Both confirmations are required");
  const bothConfirmed = transitionPairing(
    hostConfirmed,
    { kind: "confirm-mobile", transcriptHash: hash },
    1_000n,
  );
  expect(
    transitionPairing(bothConfirmed, { kind: "complete", routeId: routeId("route-1") }, 1_000n)
      .kind,
  ).toBe("completed");
  expect(transitionPairing(initial, { kind: "claim", transcriptHash: hash }, 2_000n).kind).toBe(
    "expired",
  );
});

test("subscription ordering and credential adapters enforce security boundaries", async () => {
  const active = { kind: "active" as const, usableUntilMs: 2_000n };
  expect(mayUseRelay(active, 1_000n)).toBeTrue();
  expect(mayUseRelay({ kind: "paused" }, 1_000n)).toBeFalse();
  const current = { state: active, lastOccurredAtMs: 10n };
  expect(
    applySubscriptionEvent(current, {
      providerEventId: "older",
      occurredAtMs: 9n,
      receivedAtMs: 11n,
      state: { kind: "expired" },
    }).changed,
  ).toBeFalse();
  expect(
    applySubscriptionEvent(current, {
      providerEventId: "newer",
      occurredAtMs: 12n,
      receivedAtMs: 12n,
      state: { kind: "grace-period", usableUntilMs: 3_000n },
    }).changed,
  ).toBeTrue();
  const credential = "a".repeat(64);
  const passwordHash = await hashCredential(credential);
  expect(await verifyCredential(credential, passwordHash)).toBeTrue();
  expect(await verifyCredential("wrong", passwordHash)).toBeFalse();
  expect(hashCredential("short")).rejects.toThrow();
  expect(new SystemClock().nowMs()).toBeGreaterThan(0n);
  expect(new UuidV7Generator().newId()).toMatch(/^[0-9a-f-]{36}$/);
}, 15_000);

const encodeRevenueCatEvent = (event: Record<string, unknown>): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      api_version: "1.0",
      event: {
        id: "event-1",
        app_user_id: "account-1",
        event_timestamp_ms: 1_000,
        entitlement_ids: ["relay_pro"],
        ...event,
      },
    }),
  );

test("RevenueCat webhooks authenticate raw requests and normalize lifecycle states", () => {
  const authorization = `Bearer ${"s".repeat(32)}`;
  const verifier = new RevenueCatWebhookVerifier(authorization);
  expect(() =>
    verifier.verifyAndNormalize(
      encodeRevenueCatEvent({ type: "EXPIRATION" }),
      "Bearer wrong",
      2_000n,
    ),
  ).toThrow("INVALID_WEBHOOK_AUTHORIZATION");
  const renewal = verifier.verifyAndNormalize(
    encodeRevenueCatEvent({ type: "RENEWAL", expiration_at_ms: 10_000 }),
    authorization,
    2_000n,
  );
  expect(String(renewal.accountId)).toBe("account-1");
  expect(renewal.event.state).toEqual({ kind: "active", usableUntilMs: 10_000n });
  const grace = verifier.verifyAndNormalize(
    encodeRevenueCatEvent({
      id: "event-2",
      type: "BILLING_ISSUE",
      grace_period_expiration_at_ms: 20_000,
    }),
    authorization,
    2_000n,
  );
  expect(grace.event.state).toEqual({ kind: "grace-period", usableUntilMs: 20_000n });
  const cancellation = verifier.verifyAndNormalize(
    encodeRevenueCatEvent({ id: "event-3", type: "CANCELLATION", expiration_at_ms: 10_000 }),
    authorization,
    2_000n,
  );
  expect(cancellation.event.state).toEqual({ kind: "active", usableUntilMs: 10_000n });
  expect(() =>
    verifier.verifyAndNormalize(encodeRevenueCatEvent({ type: "UNKNOWN" }), authorization, 2_000n),
  ).toThrow("UNSUPPORTED_WEBHOOK_EVENT");
});

test("push secrets stay encrypted and Expo payloads contain wake metadata only", async () => {
  const protector = await AesGcmSecretProtector.fromRawKey(
    new Uint8Array(32).fill(4),
    "push-key-1",
  );
  const protectedToken = await protector.encrypt("ExponentPushToken[test-token]");
  expect(new TextDecoder().decode(protectedToken.ciphertext)).not.toContain("ExponentPushToken");
  expect(await protector.decrypt(protectedToken)).toBe("ExponentPushToken[test-token]");
  let requestBody = "";
  const gateway = new ExpoPushGateway(async (_input, init) => {
    requestBody = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({ data: [{ status: "ok", id: "receipt-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await gateway.send("ExponentPushToken[test-token]", { kind: "WAKE", wakeId: "wake-1" });
  expect(JSON.parse(requestBody)).toEqual({
    to: "ExponentPushToken[test-token]",
    data: { kind: "WAKE", wake_id: "wake-1" },
    priority: "high",
  });
});

test("Ed25519 relay tickets carry bounded signed routing claims", async () => {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { extractable: true });
  const signer = await Ed25519RelayTicketSigner.fromPkcs8(
    await exportPKCS8(privateKey),
    "ticket-key-1",
  );
  const issuedAtSeconds = BigInt(Math.floor(Date.now() / 1000));
  const claims: RelayTicketClaims = {
    issuer: "https://control.example.test",
    audience: "pocket-omp-relay",
    accountId: accountId("account-1"),
    deviceId: deviceId("device-1"),
    deviceKind: "HOST",
    routeGrants: [routeId("route-1")],
    entitlement: "relay_pro",
    credentialGeneration: 3n,
    homeRegion: "home-1",
    relayOrigin: new URL("https://home-1.relay.example.test"),
    routeEpoch: 7n,
    issuedAtSeconds,
    expiresAtSeconds: issuedAtSeconds + 600n,
    ticketId: "ticket-1",
  };
  const ticket = await signer.sign(claims);
  const verified = await jwtVerify(ticket, publicKey, {
    algorithms: ["EdDSA"],
    issuer: claims.issuer,
    audience: claims.audience,
  });
  expect(verified.protectedHeader.kid).toBe("ticket-key-1");
  expect(verified.payload.device_id).toBe("device-1");
  expect(verified.payload.route_epoch).toBe(7);
  if (verified.payload.exp === undefined || verified.payload.iat === undefined) {
    throw new Error("Signed ticket is missing temporal claims");
  }
  expect(verified.payload.exp - verified.payload.iat).toBe(600);
});

describe("PostgreSQL control contracts", () => {
  test("account, device, entitlement, route, ticket and revocation remain transactional", async () => {
    const store = await PostgresControlStore.connect(databaseUrl);
    try {
      await store.migrate();
      await store.migrate();
      const accounts = new PostgresAccountRepository(store);
      const devices = new PostgresDeviceRepository(store);
      const routes = new PostgresRegionRouteRepository(store);
      const entitlements = new PostgresEntitlementRepository(store);
      const signer = new CapturingSigner();
      const ids = new SequentialIds();
      const nowMs = BigInt(Date.now());
      const application = new ControlApplication(
        accounts,
        devices,
        routes,
        entitlements,
        signer,
        new FastHasher(),
        new PostgresControlOutbox(store),
        { nowMs: () => nowMs },
        ids,
        "https://control.example.test",
      );

      const subject = `subject-${Date.now()}`;
      const account = await application.authenticate({
        provider: "apple",
        subject,
        email: `${subject}@example.test`,
      });
      const sameAccount = await application.authenticate({ provider: "apple", subject });
      expect(sameAccount.accountId).toBe(account.accountId);

      const host = await application.registerDevice({
        accountId: account.accountId,
        kind: "HOST",
        name: "Workstation",
        publicKey: new Uint8Array(32).fill(1),
      });
      const mobile = await application.registerDevice({
        accountId: account.accountId,
        kind: "MOBILE",
        name: "Phone",
        publicKey: new Uint8Array(32).fill(2),
      });
      expect(host.credential.length).toBeGreaterThanOrEqual(32);
      expect((await devices.list(account.accountId)).length).toBe(2);

      const protector = await AesGcmSecretProtector.fromRawKey(
        new Uint8Array(32).fill(5),
        "push-key-db",
      );
      const deliveredTokens: string[] = [];
      const push = new PushApplication(
        devices,
        new PostgresPushTokenRepository(store),
        protector,
        {
          send: async (token) => {
            deliveredTokens.push(token);
          },
        },
        ids,
      );
      const pushToken = "ExponentPushToken[integration-token]";
      await push.register(account.accountId, mobile.device.deviceId, "expo", pushToken);
      expect(await push.sendWake(mobile.device.deviceId, "wake-integration")).toBe(1);
      expect(deliveredTokens).toEqual([pushToken]);

      const pushEventId = `push-event-${Date.now()}`;
      await new PostgresControlOutbox(store).append({
        eventId: pushEventId,
        kind: "PushWakeRequested",
        payload: { deviceId: mobile.device.deviceId, wakeId: "wake-worker" },
      });
      const workerResult = await new PushWorker(
        new PostgresPushWorkQueue(store),
        push,
        { nowMs: () => nowMs },
        "worker-test",
      ).runOnce();
      expect(workerResult.failed).toBe(0);
      expect(workerResult.completed).toBeGreaterThanOrEqual(1);

      const storage: ObjectStorageGateway = {
        createUpload: async (objectId) => ({
          url: new URL(`https://objects.example.test/upload/${objectId}`),
          requiredHeaders: { "x-content-encrypted": "1" },
          storageRegion: "home-1",
        }),
        createDownload: async (objectId) => ({
          url: new URL(`https://objects.example.test/download/${objectId}`),
          requiredHeaders: {},
        }),
      };
      const attachmentRepository = new PostgresAttachmentRepository(store);
      const attachments = new AttachmentApplication(
        attachmentRepository,
        storage,
        { nowMs: () => nowMs },
        ids,
      );
      const upload = await attachments.createUpload(
        account.accountId,
        1_024n,
        new Uint8Array(32).fill(3),
        nowMs + 60_000n,
      );
      expect(upload.uploadUrl.protocol).toBe("https:");
      expect((await attachmentRepository.get(upload.objectId))?.ciphertextSize).toBe(1_024n);

      const applied = await entitlements.applyEvent(account.accountId, {
        providerEventId: `billing-${Date.now()}`,
        occurredAtMs: nowMs,
        receivedAtMs: nowMs,
        state: { kind: "active", usableUntilMs: nowMs + 86_400_000n },
      });
      expect(applied).toBeTrue();
      const duplicate = await entitlements.applyEvent(account.accountId, {
        providerEventId: `billing-duplicate-${Date.now()}`,
        occurredAtMs: nowMs - 1n,
        receivedAtMs: nowMs,
        state: { kind: "expired" },
      });
      expect(duplicate).toBeFalse();

      const pairingSecrets = new BunPairingSecrets();
      const pairingApplication = new PairingApplication(
        new PostgresPairingRepository(store),
        pairingSecrets,
        { nowMs: () => nowMs },
        ids,
        {
          serviceIdentifier: "pocket-omp",
          homeRegion: "home-1",
          standbyRegion: "standby-1",
          relayOrigin: new URL("https://home-1.relay.example.test"),
          lifetimeMs: 300_000n,
        },
      );
      const pairing = await pairingApplication.begin("Workstation", host.device.publicKey);
      expect(
        (await pairingApplication.authenticateWatcher(pairing.pairingId, pairing.watchSecret)).state
          .kind,
      ).toBe("awaiting-claim");
      const transcriptHash = new Uint8Array(32).fill(9);
      await pairingApplication.claim({
        pairingId: pairing.pairingId,
        accountId: account.accountId,
        mobileDeviceId: mobile.device.deviceId,
        mobilePublicKey: mobile.device.publicKey,
        challenge: pairing.challenge,
        transcriptHash,
      });
      await pairingApplication.confirm(pairing.pairingId, "host", transcriptHash);
      await pairingApplication.confirm(pairing.pairingId, "mobile", transcriptHash);
      const completedRoute = await pairingApplication.complete(
        pairing.pairingId,
        host.device.deviceId,
      );
      const route = completedRoute.routeId;
      const issued = await application.issueRelayTicket(account.accountId, host.device.deviceId, [
        route,
      ]);
      expect(issued.ticket).toBe("signed-ticket");
      expect(issued.claims.routeEpoch).toBe(1n);
      const adminSecurity = new PostgresAdminSecurity(store);
      const readGrant = `grant-read-${Date.now()}`;
      const writeGrant = `grant-write-${Date.now()}`;
      await store.provisionSupportAccess(
        "staff-1",
        "support-read",
        readGrant,
        account.accountId,
        "Customer-requested diagnostics",
        nowMs + 300_000n,
      );
      await store.provisionSupportAccess(
        "staff-1",
        "support-write",
        writeGrant,
        account.accountId,
        "Customer-requested revocation",
        nowMs + 300_000n,
      );
      const admin = new AdminApplication(
        adminSecurity,
        adminSecurity,
        accounts,
        devices,
        entitlements,
        {
          getDeliveryMetadata: async () => ({
            queueCount: 0n,
            queueBytes: 0n,
            ackLag: 0n,
            homeRegion: "home-1",
            routeEpoch: 1n,
          }),
        },
        { nowMs: () => nowMs },
        ids,
      );
      const principal = {
        staffSubject: "staff-1",
        roles: new Set(["support-read", "support-write"] as const),
        authenticatedAtMs: nowMs,
        stepUpAtMs: nowMs,
      };
      const diagnostics = await admin.getAccountDiagnostics(
        principal,
        account.accountId,
        readGrant,
        "correlation-read",
      );
      expect(diagnostics.devices.length).toBe(2);
      await admin.revokeDevice(
        principal,
        account.accountId,
        host.device.deviceId,
        writeGrant,
        "correlation-write",
      );

      expect(issued.claims.expiresAtSeconds - issued.claims.issuedAtSeconds).toBe(600n);

      expect((await devices.get(host.device.deviceId))?.credentialGeneration).toBe(2n);
      expect(
        application.issueRelayTicket(account.accountId, host.device.deviceId, [route]),
      ).rejects.toThrow("Device is not authorized");
      expect(accountId(account.accountId)).toBe(account.accountId);
    } finally {
      await store.close();
    }
  }, 30_000);
});

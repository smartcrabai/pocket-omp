import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  DeviceSchema,
  ForceEntitlementReconciliationRequestSchema,
  ForceEntitlementReconciliationResponseSchema,
  GetAccountDiagnosticsRequestSchema,
  GetAccountDiagnosticsResponseSchema,
  GetDeliveryMetadataRequestSchema,
  GetDeliveryMetadataResponseSchema,
  RevokeDeviceAsSupportRequestSchema,
  RevokeDeviceAsSupportResponseSchema,
} from "@pocket-omp/proto/control/v1";
import {
  AckRequestSchema,
  AckResponseSchema,
  GetSnapshotRequestSchema,
  type PublishResult,
  PublishRequestSchema,
  PublishResponseSchema,
  PublishResultSchema,
  PutSnapshotRequestSchema,
  RejectedSchema,
} from "@pocket-omp/proto/relay/v1";
import {
  type AdminPrincipal,
  type AdminRole,
  ControlInvariantError,
  accountId,
  deviceId,
} from "@pocket-omp/control-core";
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from "jose";
import { AdminControl, authorizeAdminAction, createAdminServices } from "./admin";
import {
  beginPairing,
  claimPairing,
  completePairing,
  createControlPlane,
  deleteRoute,
  getEntitlement,
  getRouteRecipientDevice,
  issueRelayTicket,
  listDevices,
  refreshEntitlement,
  registerPushTokens,
  relayJwks,
  relayVerificationKeys,
  relayWake,
  renameDevice,
  revokeDevice,
  watchPairing,
} from "./control";
import { RelayMailbox, type PushEvent } from "./relay";
import { ReviewSession } from "./review";

export { AdminControl, RelayMailbox, ReviewSession };

interface RelayPrincipal {
  readonly accountId: string;
  readonly deviceId: string;
  readonly routeGrants: ReadonlySet<string>;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return Response.json({ status: "ok" });
      if (url.pathname === "/readyz") return Response.json({ status: "ready" });
      if (url.pathname === "/v1/relay/publish" && request.method === "POST")
        return await publish(request, env);
      if (url.pathname === "/v1/relay/ack" && request.method === "POST")
        return await relayAck(request, env);
      if (url.pathname === "/v1/relay/snapshot" && request.method === "PUT")
        return await relaySnapshotPut(request, env);
      if (url.pathname === "/v1/relay/snapshot" && request.method === "POST")
        return await relaySnapshotGet(request, env);
      if (url.pathname === "/v1/relay/subscribe" && request.headers.get("upgrade") === "websocket")
        return await subscribe(request, env);
      if (url.pathname === "/v1/control/push-registration" && request.method === "PUT")
        return await registerPush(request, env);
      if (url.pathname === "/api/diagnostics" && request.method === "GET")
        return await adminLegacyDiagnostics(request, env);
      if (url.pathname === "/v1/admin/account-diagnostics" && request.method === "POST")
        return await adminAccountDiagnostics(request, env);
      if (
        url.pathname === "/v1/admin/force-entitlement-reconciliation" &&
        request.method === "POST"
      )
        return await adminForceReconciliation(request, env);
      if (url.pathname === "/v1/admin/revoke-device" && request.method === "POST")
        return await adminRevokeDevice(request, env);
      if (url.pathname === "/v1/admin/delivery-metadata" && request.method === "POST")
        return await adminDeliveryMetadata(request, env);
      if (url.pathname === "/v1/review/sessions" && request.method === "POST")
        return await startReview(request, env);
      if (
        /^\/v1\/review\/sessions\/[^/]+\/approval$/.test(url.pathname) &&
        request.method === "POST"
      )
        return await approveReview(request, env);
      return await routeControlPlane(url, request, env);
    } catch (error) {
      if (error instanceof HttpError)
        return Response.json(
          { code: error.code, message: error.message },
          { status: error.status },
        );
      if (isControlInvariantError(error)) {
        const denied = error.message.toLowerCase().includes("denied");
        return Response.json(
          { code: denied ? "ACCESS_DENIED" : "INVALID_REQUEST", message: error.message },
          { status: denied ? 403 : 400 },
        );
      }
      console.error(
        JSON.stringify({ event: "unhandled_request_error", error: errorMessage(error) }),
      );
      return Response.json({ code: "INTERNAL" }, { status: 500 });
    }
  },

  async queue(batch: MessageBatch<PushEvent>, env: Env): Promise<void> {
    await Promise.all(batch.messages.map((message) => processPushMessage(message, env)));
  },
} satisfies ExportedHandler<Env, PushEvent>;

async function processPushMessage(message: Message<PushEvent>, env: Env): Promise<void> {
  try {
    const event = message.body;
    if (
      typeof event?.eventId !== "string" ||
      typeof event.recipientDeviceId !== "string" ||
      typeof event.notificationHint !== "number"
    ) {
      console.error(JSON.stringify({ event: "invalid_push_event", messageId: message.id }));
      message.ack();
      return;
    }
    const routeId = typeof event.routeId === "string" ? event.routeId : "";
    const mailbox = env.RELAY_MAILBOX.getByName(event.recipientDeviceId);
    const claimResponse = await mailbox.fetch("https://mailbox.internal/push-claim", {
      method: "POST",
      body: JSON.stringify({ eventId: event.eventId }),
    });
    if (!claimResponse.ok) throw new Error(`Push claim failed with ${claimResponse.status}`);
    const rawClaim: unknown = await claimResponse.json();
    if (!isRecord(rawClaim) || typeof rawClaim.status !== "string")
      throw new Error("Push claim returned an invalid response");
    if (rawClaim.status === "busy") {
      message.retry({ delaySeconds: 60 });
      return;
    }
    if (rawClaim.status !== "ready") {
      message.ack();
      return;
    }
    if (typeof rawClaim.expoPushToken !== "string")
      throw new Error("Push claim omitted the Expo token");
    const pushResponse = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: rawClaim.expoPushToken,
        title: "Pocket OMP",
        body: "A session has new activity.",
        // The mobile notification listener keys on wake_id/route_id.
        data: { wake_id: event.eventId, route_id: routeId },
      }),
    });
    if (!pushResponse.ok) throw new Error(`Expo push failed with ${pushResponse.status}`);
    // Expo returns HTTP 200 with per-ticket statuses; an error ticket means
    // the notification never reached the device and must not be marked
    // delivered.
    const rawPushResult: unknown = await pushResponse.json();
    const tickets =
      isRecord(rawPushResult) && Array.isArray(rawPushResult.data) ? rawPushResult.data : [];
    const ticketError = tickets.find((ticket) => isRecord(ticket) && ticket.status === "error");
    if (ticketError !== undefined) {
      const details =
        isRecord(ticketError) && isRecord(ticketError.details) ? ticketError.details : {};
      const errorCode = typeof details.error === "string" ? details.error : "UNKNOWN";
      if (errorCode === "DeviceNotRegistered") {
        // The token is permanently dead; complete so the outbox row is
        // reaped instead of retrying a delivery that can never succeed.
        console.warn(JSON.stringify({ event: "push_token_unregistered", messageId: message.id }));
      } else {
        throw new Error(`Expo push ticket rejected with ${errorCode}`);
      }
    }
    const completeResponse = await mailbox.fetch("https://mailbox.internal/push-complete", {
      method: "POST",
      body: JSON.stringify({ eventId: event.eventId }),
    });
    if (!completeResponse.ok)
      throw new Error(`Push completion failed with ${completeResponse.status}`);
    message.ack();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "push_delivery_failed",
        messageId: message.id,
        error: errorMessage(error),
      }),
    );
    message.retry();
  }
}

export default worker;

async function publish(request: Request, env: Env): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const body = decode(PublishRequestSchema, bytes);
  if (body.envelopes.length === 0 || body.envelopes.length > 64)
    throw new HttpError(400, "BATCH_SIZE", "Envelope batch must contain 1-64 items");
  const principal = await authorize(request, env);
  if (principal !== undefined) {
    for (const envelope of body.envelopes) {
      if (envelope.senderDeviceId !== principal.deviceId)
        throw new HttpError(403, "SENDER_MISMATCH", "Ticket device does not match the sender");
      if (!principal.routeGrants.has(envelope.routeId))
        throw new HttpError(403, "ROUTE_NOT_GRANTED", "Ticket does not grant the envelope route");
    }
  }

  const groups = new Map<string, typeof body.envelopes>();
  for (const envelope of body.envelopes) {
    const group = groups.get(envelope.recipientDeviceId);
    if (group === undefined) groups.set(envelope.recipientDeviceId, [envelope]);
    else group.push(envelope);
  }
  const resultsByMessage = new Map<string, PublishResult>();
  await Promise.all(
    [...groups].map(async ([recipient, envelopes]) => {
      const response = await env.RELAY_MAILBOX.getByName(recipient).fetch(
        "https://mailbox.internal/publish",
        {
          method: "POST",
          headers: { "content-type": "application/protobuf" },
          body: toBinary(PublishRequestSchema, create(PublishRequestSchema, { envelopes })),
        },
      );
      if (!response.ok) {
        const rawFailure: unknown = await response.json();
        const code =
          isRecord(rawFailure) && typeof rawFailure.code === "string"
            ? rawFailure.code
            : "MAILBOX_FAILURE";
        const message =
          isRecord(rawFailure) && typeof rawFailure.message === "string"
            ? rawFailure.message
            : "Mailbox rejected the envelope";
        for (const envelope of envelopes)
          resultsByMessage.set(
            envelope.messageId,
            create(PublishResultSchema, {
              messageId: envelope.messageId,
              outcome: {
                case: "rejected",
                value: create(RejectedSchema, { code, message }),
              },
            }),
          );
        return;
      }
      const mailboxResult = decode(
        PublishResponseSchema,
        new Uint8Array(await response.arrayBuffer()),
      );
      for (const result of mailboxResult.results) resultsByMessage.set(result.messageId, result);
    }),
  );

  let acceptedAckServerSequence = 0n;
  if (body.ackServerSequence !== undefined && principal !== undefined) {
    const ackRequest = create(AckRequestSchema, {
      recipientDeviceId: principal.deviceId,
      serverSequence: body.ackServerSequence,
    });
    const ackResponse = await env.RELAY_MAILBOX.getByName(principal.deviceId).fetch(
      "https://mailbox.internal/ack",
      {
        method: "POST",
        body: toBinary(AckRequestSchema, ackRequest),
      },
    );
    if (!ackResponse.ok) {
      // The mailbox signals ack failures as JSON, but this endpoint speaks
      // protobuf. Surface the ack failure as per-message rejections so the
      // client can parse the response.
      const rawError: unknown = await ackResponse.json();
      const code =
        isRecord(rawError) && typeof rawError.code === "string" ? rawError.code : "ACK_FAILED";
      const message =
        isRecord(rawError) && typeof rawError.message === "string"
          ? rawError.message
          : "Acknowledgement was rejected";
      return new Response(
        toBinary(
          PublishResponseSchema,
          create(PublishResponseSchema, {
            results: body.envelopes.map((envelope) =>
              create(PublishResultSchema, {
                messageId: envelope.messageId,
                outcome: {
                  case: "rejected",
                  value: create(RejectedSchema, { code, message }),
                },
              }),
            ),
          }),
        ),
        { headers: { "content-type": "application/protobuf", "cache-control": "no-store" } },
      );
    }
    acceptedAckServerSequence = decode(
      AckResponseSchema,
      new Uint8Array(await ackResponse.arrayBuffer()),
    ).acceptedServerSequence;
  }

  const results = body.envelopes.flatMap((envelope) => {
    const result = resultsByMessage.get(envelope.messageId);
    return result === undefined ? [] : [result];
  });
  return new Response(
    toBinary(
      PublishResponseSchema,
      create(PublishResponseSchema, { results, acceptedAckServerSequence }),
    ),
    { headers: { "content-type": "application/protobuf", "cache-control": "no-store" } },
  );
}

async function relayAck(request: Request, env: Env): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const body = decode(AckRequestSchema, bytes);
  const principal = await authorize(request, env);
  if (principal !== undefined && principal.deviceId !== body.recipientDeviceId)
    throw new HttpError(403, "DEVICE_MISMATCH", "Ticket cannot access this mailbox");
  return env.RELAY_MAILBOX.getByName(body.recipientDeviceId).fetch("https://mailbox.internal/ack", {
    method: "POST",
    headers: { "content-type": "application/protobuf" },
    body: bytes,
  });
}

async function relaySnapshotGet(request: Request, env: Env): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const body = decode(GetSnapshotRequestSchema, bytes);
  const principal = await authorize(request, env);
  if (principal !== undefined && principal.deviceId !== body.recipientDeviceId)
    throw new HttpError(403, "DEVICE_MISMATCH", "Ticket cannot access this mailbox");
  return env.RELAY_MAILBOX.getByName(body.recipientDeviceId).fetch(
    "https://mailbox.internal/snapshot",
    {
      method: "POST",
      headers: { "content-type": "application/protobuf" },
      body: bytes,
    },
  );
}

async function relaySnapshotPut(request: Request, env: Env): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  const body = decode(PutSnapshotRequestSchema, bytes);
  const snapshot = body.snapshot;
  if (snapshot === undefined) throw new HttpError(400, "INVALID_SNAPSHOT", "Snapshot is required");
  const principal = await authorize(request, env);
  if (principal !== undefined && principal.deviceId !== snapshot.recipientDeviceId)
    throw new HttpError(403, "DEVICE_MISMATCH", "Ticket cannot access this mailbox");
  return env.RELAY_MAILBOX.getByName(snapshot.recipientDeviceId).fetch(
    "https://mailbox.internal/snapshot",
    { method: "PUT", headers: { "content-type": "application/protobuf" }, body: bytes },
  );
}

async function subscribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const recipient = requiredQuery(url, "recipient_device_id");
  const principal = await authorize(request, env);
  if (principal !== undefined && principal.deviceId !== recipient)
    throw new HttpError(403, "DEVICE_MISMATCH", "Ticket cannot subscribe to this mailbox");
  const mailboxUrl = new URL("https://mailbox.internal/subscribe");
  mailboxUrl.searchParams.set("after", url.searchParams.get("after") ?? "0");
  mailboxUrl.searchParams.set(
    "generation",
    url.searchParams.get("generation") ?? crypto.randomUUID(),
  );
  return env.RELAY_MAILBOX.getByName(recipient).fetch(
    new Request(mailboxUrl, { headers: request.headers }),
  );
}

async function registerPush(request: Request, env: Env): Promise<Response> {
  const body: unknown = await request.json();
  if (
    !isRecord(body) ||
    typeof body.recipientDeviceId !== "string" ||
    typeof body.expoPushToken !== "string"
  )
    throw new HttpError(400, "INVALID_REQUEST", "recipientDeviceId and expoPushToken are required");
  const principal = await authorize(request, env);
  if (principal !== undefined && principal.deviceId !== body.recipientDeviceId)
    throw new HttpError(403, "DEVICE_MISMATCH", "Ticket cannot update this mailbox");
  return env.RELAY_MAILBOX.getByName(body.recipientDeviceId).fetch(
    "https://mailbox.internal/push-registration",
    { method: "PUT", body: JSON.stringify({ expoPushToken: body.expoPushToken }) },
  );
}

async function adminLegacyDiagnostics(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const principal = await authenticateAdmin(request, env);
  const services = createAdminServices(env);
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  const result = await services.application.getAccountDiagnostics(
    principal,
    accountId(requiredQuery(url, "account_id")),
    requiredQuery(url, "grant_id"),
    correlationId,
  );
  return jsonResponse(result, 200, { "x-correlation-id": correlationId });
}

async function adminAccountDiagnostics(request: Request, env: Env): Promise<Response> {
  const body = decode(
    GetAccountDiagnosticsRequestSchema,
    new Uint8Array(await request.arrayBuffer()),
  );
  const principal = await authenticateAdmin(request, env);
  const services = createAdminServices(env);
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  const result = await services.application.getAccountDiagnostics(
    principal,
    accountId(body.accountId),
    body.supportAccessGrantId,
    correlationId,
  );
  return protobufResponse(
    GetAccountDiagnosticsResponseSchema,
    create(GetAccountDiagnosticsResponseSchema, {
      correlationId,
      entitlementState: result.entitlement?.kind ?? "unassigned",
      devices: result.devices.map((device) =>
        create(DeviceSchema, {
          deviceId: device.deviceId,
          name: device.name,
          kind: device.kind,
          lastSeenAtMs: device.lastSeenAtMs,
          revoked: device.revokedAtMs !== undefined,
        }),
      ),
      redactedDeliveryFindings: result.delivery.map(
        (delivery) =>
          `${delivery.deviceId}:queue=${delivery.queueCount},bytes=${delivery.queueBytes},ack_lag=${delivery.ackLag},placement=${delivery.homeRegion}`,
      ),
    }),
    { "x-correlation-id": correlationId },
  );
}

async function adminRevokeDevice(request: Request, env: Env): Promise<Response> {
  const body = decode(
    RevokeDeviceAsSupportRequestSchema,
    new Uint8Array(await request.arrayBuffer()),
  );
  const principal = await authenticateAdmin(request, env);
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  await createAdminServices(env).application.revokeDevice(
    principal,
    accountId(body.accountId),
    deviceId(body.deviceId),
    body.supportAccessGrantId,
    correlationId,
  );
  return protobufResponse(
    RevokeDeviceAsSupportResponseSchema,
    create(RevokeDeviceAsSupportResponseSchema),
    { "x-correlation-id": correlationId },
  );
}

async function adminDeliveryMetadata(request: Request, env: Env): Promise<Response> {
  const body = decode(
    GetDeliveryMetadataRequestSchema,
    new Uint8Array(await request.arrayBuffer()),
  );
  const principal = await authenticateAdmin(request, env);
  const services = createAdminServices(env);
  const account = accountId(body.accountId);
  const device = deviceId(body.deviceId);
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  await authorizeAdminAction(
    services,
    principal,
    account,
    body.supportAccessGrantId,
    "support-read",
    false,
    correlationId,
  );
  const record = await services.store.getDevice(device);
  if (record?.accountId !== account) throw new ControlInvariantError("Device not found");
  const delivery = await services.diagnostics.getDeliveryMetadata(device);
  await services.security.append({
    eventId: services.ids.newId(),
    staffSubject: principal.staffSubject,
    action: "GetDeliveryMetadata",
    accountId: account,
    targetId: device,
    correlationId,
    metadata: {},
  });
  return protobufResponse(
    GetDeliveryMetadataResponseSchema,
    create(GetDeliveryMetadataResponseSchema, delivery),
    { "x-correlation-id": correlationId },
  );
}

async function adminForceReconciliation(request: Request, env: Env): Promise<Response> {
  const body = decode(
    ForceEntitlementReconciliationRequestSchema,
    new Uint8Array(await request.arrayBuffer()),
  );
  const principal = await authenticateAdmin(request, env);
  const services = createAdminServices(env);
  const account = accountId(body.accountId);
  const correlationId = request.headers.get("x-correlation-id") ?? crypto.randomUUID();
  await authorizeAdminAction(
    services,
    principal,
    account,
    body.supportAccessGrantId,
    "billing-admin",
    true,
    correlationId,
  );
  if ((await services.store.getAccount(account)) === undefined)
    throw new ControlInvariantError("Account not found");
  const jobId = services.ids.newId();
  await services.store.enqueueReconciliation(account, principal.staffSubject, jobId);
  await services.security.append({
    eventId: services.ids.newId(),
    staffSubject: principal.staffSubject,
    action: "ForceEntitlementReconciliation",
    accountId: account,
    correlationId,
    metadata: { jobId },
  });
  return protobufResponse(
    ForceEntitlementReconciliationResponseSchema,
    create(ForceEntitlementReconciliationResponseSchema, { jobId }),
    { "x-correlation-id": correlationId },
  );
}

async function startReview(request: Request, env: Env): Promise<Response> {
  ensureReviewDeployment(env);
  const principal = await authorize(request, env);
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.account_id !== "string")
    throw new HttpError(400, "INVALID_REQUEST", "account_id is required");
  if (principal !== undefined && principal.accountId !== body.account_id)
    throw new HttpError(403, "ACCOUNT_DENIED", "Ticket cannot access this review account");
  return env.REVIEW_SESSION.getByName(body.account_id).fetch("https://review.internal/sessions", {
    method: "POST",
    body: JSON.stringify({ accountId: body.account_id }),
  });
}

async function approveReview(request: Request, env: Env): Promise<Response> {
  ensureReviewDeployment(env);
  const principal = await authorize(request, env);
  const body: unknown = await request.json();
  if (!isRecord(body) || typeof body.account_id !== "string" || typeof body.allow !== "boolean")
    throw new HttpError(400, "INVALID_REQUEST", "account_id and allow are required");
  if (principal !== undefined && principal.accountId !== body.account_id)
    throw new HttpError(403, "ACCOUNT_DENIED", "Ticket cannot access this review account");
  const sessionId = new URL(request.url).pathname.split("/")[4];
  if (sessionId === undefined)
    throw new HttpError(400, "INVALID_REQUEST", "Session ID is required");
  return env.REVIEW_SESSION.getByName(body.account_id).fetch(
    `https://review.internal/sessions/${encodeURIComponent(sessionId)}/approval`,
    { method: "POST", body: JSON.stringify({ accountId: body.account_id, allow: body.allow }) },
  );
}

async function authorize(request: Request, env: Env): Promise<RelayPrincipal | undefined> {
  if (env.RELAY_AUTH_DISABLED === "true") return undefined;
  const authorization = request.headers.get("authorization");
  const protocolTicket = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("pocket-omp-ticket."))
    ?.slice("pocket-omp-ticket.".length);
  const ticket =
    authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : protocolTicket;
  if (ticket === undefined || ticket.length === 0)
    throw new HttpError(401, "UNAUTHENTICATED", "Bearer ticket is required");
  try {
    const verified = await jwtVerify(ticket, createLocalJWKSet(await relayVerificationKeys(env)), {
      issuer: env.RELAY_JWT_ISSUER,
      audience: "pocket-omp-relay",
      algorithms: ["EdDSA"],
    });
    const accountClaim = verified.payload.account_id;
    const deviceClaim = verified.payload.device_id;
    const routeGrants = verified.payload.route_grants;
    const generationClaim = verified.payload.credential_generation;
    const validRouteGrants = Array.isArray(routeGrants)
      ? routeGrants.filter((route): route is string => typeof route === "string")
      : [];
    const routeGrantsValid =
      Array.isArray(routeGrants) && validRouteGrants.length === routeGrants.length;
    if (
      typeof accountClaim !== "string" ||
      typeof deviceClaim !== "string" ||
      verified.payload.sub !== deviceClaim ||
      !routeGrantsValid ||
      verified.payload.entitlement !== "relay_pro"
    )
      throw new Error("Invalid relay claims");
    // Revocation gate (restores the legacy per-request check): a revoked
    // device bumps credential_generation, which invalidates already-issued
    // tickets instead of letting them live out their 600s lifetime.
    if (typeof generationClaim !== "string") throw new Error("Invalid relay claims");
    const device = await env.ADMIN_CONTROL.getByName("control").getDevice(deviceId(deviceClaim));
    if (
      device === undefined ||
      device.revokedAtMs !== undefined ||
      device.credentialGeneration.toString() !== generationClaim
    )
      throw new Error("Device credential is no longer valid");
    return {
      accountId: accountClaim,
      deviceId: deviceClaim,
      routeGrants: new Set(validRouteGrants),
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: "relay_ticket_rejected", error: errorMessage(error) }));
    throw new HttpError(401, "UNAUTHENTICATED", "Relay ticket is invalid");
  }
}

async function authenticateAdmin(request: Request, env: Env): Promise<AdminPrincipal> {
  if (env.ADMIN_AUTH_DISABLED === "true") {
    const staffSubject = request.headers.get("x-admin-subject");
    if (staffSubject === null || staffSubject.length === 0)
      throw new HttpError(401, "UNAUTHENTICATED", "Admin subject is required");
    const roles = adminRoles(request.headers.get("x-admin-roles")?.split(",") ?? []);
    const now = BigInt(Date.now());
    const stepUp = request.headers.get("x-admin-step-up-at-ms");
    return {
      staffSubject,
      roles,
      authenticatedAtMs: now,
      ...(stepUp === null ? {} : { stepUpAtMs: parseMilliseconds(stepUp) }),
    };
  }
  const authorization = request.headers.get("authorization");
  const staffJwt =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice(7)
      : request.headers.get("cf-access-jwt-assertion");
  if (staffJwt === null || staffJwt === undefined || staffJwt.length === 0)
    throw new HttpError(401, "UNAUTHENTICATED", "Staff JWT is required");
  try {
    const verified = await jwtVerify(
      staffJwt,
      createRemoteJWKSet(new URL(env.STAFF_SSO_JWKS_URL)),
      {
        issuer: env.STAFF_SSO_ISSUER,
        audience: env.STAFF_SSO_AUDIENCE,
        algorithms: ["EdDSA", "ES256", "RS256"],
      },
    );
    if (typeof verified.payload.sub !== "string" || verified.payload.sub.length === 0)
      throw new Error("JWT subject required");
    const authenticatedAtMs = secondsToMilliseconds(verified.payload.iat);
    const stepUpAtMs =
      verified.payload.step_up_at === undefined
        ? undefined
        : secondsToMilliseconds(verified.payload.step_up_at);
    return {
      staffSubject: verified.payload.sub,
      roles: adminRoles(verified.payload.roles),
      authenticatedAtMs,
      ...(stepUpAtMs === undefined ? {} : { stepUpAtMs }),
    };
  } catch (error) {
    console.warn(JSON.stringify({ event: "admin_ticket_rejected", error: errorMessage(error) }));
    throw new HttpError(401, "UNAUTHENTICATED", "Staff JWT is invalid");
  }
}

function adminRoles(value: unknown): ReadonlySet<AdminRole> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter(isAdminRole));
}

function isAdminRole(value: unknown): value is AdminRole {
  return (
    value === "support-read" ||
    value === "support-write" ||
    value === "billing-admin" ||
    value === "security-admin"
  );
}

function secondsToMilliseconds(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid JWT timestamp");
  return BigInt(value) * 1_000n;
}

function parseMilliseconds(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new HttpError(400, "INVALID_REQUEST", "Invalid timestamp");
  return BigInt(value);
}

function ensureReviewDeployment(env: Env): void {
  if (env.REVIEW_HOST_ENABLED !== "true" || env.DEPLOYMENT_PURPOSE !== "app-review")
    throw new HttpError(404, "NOT_FOUND", "Review Host is disabled");
}

function decode<Desc extends DescMessage>(schema: Desc, bytes: Uint8Array): MessageShape<Desc> {
  try {
    return fromBinary(schema, bytes);
  } catch (error) {
    throw new HttpError(400, "MALFORMED_PROTOBUF", errorMessage(error));
  }
}

function protobufResponse<Desc extends DescMessage>(
  schema: Desc,
  value: MessageShape<Desc>,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(toBinary(schema, value), {
    headers: {
      ...headers,
      "cache-control": "no-store",
      "content-type": "application/protobuf",
    },
  });
}

function jsonResponse(
  value: unknown,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
    {
      status,
      headers: {
        ...headers,
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "content-type": "application/json; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0)
    throw new HttpError(400, "INVALID_REQUEST", `${name} is required`);
  return value;
}

async function routeControlPlane(url: URL, request: Request, env: Env): Promise<Response> {
  const plane = createControlPlane(env);
  if (url.pathname === "/.well-known/jwks.json" && request.method === "GET")
    return relayJwks(plane);
  if (url.pathname === "/v1/pairings" && request.method === "POST")
    return beginPairing(request, plane);
  const pairingMatch = /^\/v1\/pairings\/([^/]+)(?:\/(claim|complete|watch))?$/.exec(url.pathname);
  if (pairingMatch !== null) {
    const pairingId = pairingMatch[1] ?? "";
    const action = pairingMatch[2];
    if (action === "watch" && request.method === "GET")
      return watchPairing(request, plane, pairingId);
    if (action === "claim" && request.method === "POST")
      return claimPairing(request, plane, pairingId);
    if (action === "complete" && request.method === "POST")
      return completePairing(request, plane, pairingId);
  }
  const routeMatch = /^\/v1\/routes\/([^/]+)$/.exec(url.pathname);
  if (routeMatch !== null && request.method === "DELETE")
    return deleteRoute(request, plane, routeMatch[1] ?? "");
  const routeRecipientMatch = /^\/v1\/routes\/([^/]+)\/recipient-device-id$/.exec(url.pathname);
  if (routeRecipientMatch !== null && request.method === "POST")
    return getRouteRecipientDevice(request, plane, routeRecipientMatch[1] ?? "");
  if (url.pathname === "/v1/devices" && request.method === "GET")
    return listDevices(request, plane);
  const deviceMatch = /^\/v1\/devices\/([^/]+)(?:\/(rename|revoke))?$/.exec(url.pathname);
  if (deviceMatch !== null) {
    const target = deviceMatch[1] ?? "";
    const action = deviceMatch[2];
    if (action === "rename" && request.method === "POST")
      return renameDevice(request, plane, target);
    if (action === "revoke" && request.method === "POST")
      return revokeDevice(request, plane, target);
    if (action === undefined && request.method === "DELETE")
      return revokeDevice(request, plane, target);
  }
  if (url.pathname === "/v1/entitlement" && request.method === "GET")
    return getEntitlement(request, plane);
  if (url.pathname === "/v1/entitlement/refresh" && request.method === "POST")
    return refreshEntitlement(request, plane);
  if (url.pathname === "/v1/relay-tickets" && request.method === "POST")
    return issueRelayTicket(request, plane);
  if (url.pathname === "/v1/push-tokens" && request.method === "POST")
    return registerPushTokens(request, plane);
  const wakeMatch = /^\/v1\/relay\/wake\/([^/]+)$/.exec(url.pathname);
  if (wakeMatch !== null && request.method === "POST")
    return relayWake(request, plane, wakeMatch[1] ?? "");
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/"))
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  return staticAsset(request, env);
}

async function staticAsset(request: Request, env: Env): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}

function isControlInvariantError(error: unknown): error is { readonly message: string } {
  return (
    error instanceof ControlInvariantError ||
    (isRecord(error) && error.name === "ControlInvariantError" && typeof error.message === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  accountId as controlAccountId,
  deviceId as controlDeviceId,
} from "@pocket-omp/control-core";
import {
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
  type AckResponse,
  EncryptedSnapshotSchema,
  GetSnapshotRequestSchema,
  GetSnapshotResponseSchema,
  OutboundEnvelopeSchema,
  type OutboundEnvelope,
  PublishRequestSchema,
  PublishResponseSchema,
  type PublishResponse,
  PutSnapshotRequestSchema,
  PutSnapshotResponseSchema,
  RelayFrameSchema,
  type RelayFrame,
} from "@pocket-omp/proto/relay/v1";

const protobufHeaders = { "content-type": "application/protobuf" };

describe("Relay Worker", () => {
  test("fans out recipients and preserves per-mailbox idempotency", async () => {
    const suffix = crypto.randomUUID();
    const first = envelope(`message-a-${suffix}`, `mobile-a-${suffix}`, new Uint8Array([1]));
    const second = envelope(`message-b-${suffix}`, `mobile-b-${suffix}`, new Uint8Array([2]));
    const initial = await publish([first, second]);
    expect(initial.results.map((item) => item.outcome.case)).toEqual(["accepted", "accepted"]);
    expect(initial.results.map(acceptedSequence)).toEqual([1n, 1n]);

    const duplicate = await publish([first]);
    expect(duplicate.results[0]?.outcome.case).toBe("accepted");
    if (duplicate.results[0]?.outcome.case !== "accepted") throw new Error("expected acceptance");
    expect(duplicate.results[0].outcome.value).toMatchObject({
      serverSequence: 1n,
      duplicate: true,
    });

    const conflict = await publish([
      create(OutboundEnvelopeSchema, { ...first, ciphertext: new Uint8Array([9]) }),
    ]);
    expect(conflict.results[0]?.outcome.case).toBe("rejected");
    if (conflict.results[0]?.outcome.case !== "rejected") throw new Error("expected rejection");
    expect(conflict.results[0].outcome.value.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("streams persisted envelopes and enforces acknowledgement bounds", async () => {
    const suffix = crypto.randomUUID();
    const recipient = `mobile-${suffix}`;
    const published = await publish([
      envelope(`message-${suffix}`, recipient, new Uint8Array([3])),
    ]);
    const sequence = acceptedSequence(published.results[0]);

    const upgrade = await exports.default.fetch(
      `https://worker.test/v1/relay/subscribe?recipient_device_id=${recipient}&after=0&generation=test`,
      { headers: { upgrade: "websocket", "sec-websocket-protocol": "pocket-omp-relay" } },
    );
    expect(upgrade.status).toBe(101);
    const socket = upgrade.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();
    const frame = await new Promise<RelayFrame>((resolve, reject) => {
      socket?.addEventListener("message", (event) => {
        void (async () => {
          const bytes =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : event.data instanceof Blob
                ? new Uint8Array(await event.data.arrayBuffer())
                : ArrayBuffer.isView(event.data)
                  ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
                  : undefined;
          if (bytes === undefined) {
            reject(new Error(`Expected a binary frame, received ${typeof event.data}`));
            return;
          }
          resolve(fromBinary(RelayFrameSchema, bytes));
        })().catch(reject);
      });
    });
    expect(frame.body.case).toBe("envelope");
    if (frame.body.case !== "envelope") throw new Error("expected envelope frame");
    expect(frame.body.value.serverSequence).toBe(sequence);
    socket?.close(1000, "test complete");

    const acknowledged = await acknowledge(recipient, sequence);
    expect(acknowledged.acceptedServerSequence).toBe(sequence);
    const beyond = await exports.default.fetch("https://worker.test/v1/relay/ack", {
      method: "POST",
      headers: protobufHeaders,
      body: toBinary(
        AckRequestSchema,
        create(AckRequestSchema, { recipientDeviceId: recipient, serverSequence: sequence + 1n }),
      ),
    });
    expect(beyond.status).toBe(400);
  });

  test("stores snapshots larger than the Durable Object SQLite row limit in R2", async () => {
    const suffix = crypto.randomUUID();
    const recipientDeviceId = `mobile-${suffix}`;
    const ciphertext = new Uint8Array(2 * 1024 * 1024 + 1);
    ciphertext[0] = 7;
    ciphertext[ciphertext.length - 1] = 9;
    const now = BigInt(Date.now());
    const snapshot = create(EncryptedSnapshotSchema, {
      snapshotId: `snapshot-${suffix}`,
      recipientDeviceId,
      routeId: "route-test",
      coversThroughSequence: 0n,
      createdAtMs: now,
      expiresAtMs: now + 300_000n,
      keyId: "key-test",
      nonce: new Uint8Array(24),
      ciphertext,
    });
    const putResponse = await exports.default.fetch("https://worker.test/v1/relay/snapshot", {
      method: "PUT",
      headers: protobufHeaders,
      body: toBinary(PutSnapshotRequestSchema, create(PutSnapshotRequestSchema, { snapshot })),
    });
    expect(putResponse.status).toBe(200);
    expect(
      fromBinary(PutSnapshotResponseSchema, new Uint8Array(await putResponse.arrayBuffer()))
        .snapshotId,
    ).toBe(snapshot.snapshotId);

    const getResponse = await exports.default.fetch("https://worker.test/v1/relay/snapshot", {
      method: "POST",
      headers: protobufHeaders,
      body: toBinary(
        GetSnapshotRequestSchema,
        create(GetSnapshotRequestSchema, { recipientDeviceId }),
      ),
    });
    expect(getResponse.status).toBe(200);
    const restored = fromBinary(
      GetSnapshotResponseSchema,
      new Uint8Array(await getResponse.arrayBuffer()),
    ).snapshot;
    expect(restored?.ciphertext.byteLength).toBe(ciphertext.byteLength);
    expect(restored?.ciphertext[0]).toBe(7);
    expect(restored?.ciphertext.at(-1)).toBe(9);
  });

  test("delivers a live sequence after 128 expired sequence holes", async () => {
    const suffix = crypto.randomUUID();
    const recipientDeviceId = `mobile-gap-${suffix}`;
    const stub = env.RELAY_MAILBOX.getByName(recipientDeviceId);
    const expired = envelope(`expired-${suffix}`, recipientDeviceId, new Uint8Array([1]));
    const payload = toBinary(OutboundEnvelopeSchema, expired);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let sequence = 1; sequence <= 128; sequence += 1)
          state.storage.sql.exec(
            "INSERT INTO message (server_sequence, sender_device_id, message_id, expires_at_ms, payload) VALUES (?, ?, ?, ?, ?)",
            sequence,
            expired.senderDeviceId,
            `${expired.messageId}-${sequence}`,
            Date.now() - 1,
            bytesBuffer(payload),
          );
        state.storage.sql.exec(
          "UPDATE mailbox_state SET next_sequence = 129, acked_sequence = 0 WHERE id = 1",
        );
      });
    });
    const published = await publish([
      envelope(`live-${suffix}`, recipientDeviceId, new Uint8Array([9])),
    ]);
    expect(acceptedSequence(published.results[0])).toBe(129n);
    const frame = await subscribeFrame(recipientDeviceId, 0n);
    expect(frame.body.case).toBe("envelope");
    if (frame.body.case !== "envelope") throw new Error("Expected a live envelope");
    expect(frame.body.value.serverSequence).toBe(129n);
  });

  test("does not postpone an earlier message expiry alarm when a later snapshot is stored", async () => {
    const suffix = crypto.randomUUID();
    const recipientDeviceId = `mobile-alarm-${suffix}`;
    await publish([envelope(`message-${suffix}`, recipientDeviceId, new Uint8Array([1]))]);
    const stub = env.RELAY_MAILBOX.getByName(recipientDeviceId);
    const messageAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(messageAlarm).not.toBeNull();
    const now = BigInt(Date.now());
    const snapshot = create(EncryptedSnapshotSchema, {
      snapshotId: `snapshot-${suffix}`,
      recipientDeviceId,
      routeId: "route-test",
      createdAtMs: now,
      expiresAtMs: now + 600_000n,
      keyId: "key-test",
      nonce: new Uint8Array(24),
      ciphertext: new Uint8Array([1]),
    });
    const response = await exports.default.fetch("https://worker.test/v1/relay/snapshot", {
      method: "PUT",
      headers: protobufHeaders,
      body: toBinary(PutSnapshotRequestSchema, create(PutSnapshotRequestSchema, { snapshot })),
    });
    expect(response.status).toBe(200);
    const afterSnapshot = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    expect(afterSnapshot).toBe(messageAlarm);
  });
});

describe("Review Worker", () => {
  test("persists approval and returns the completed event stream idempotently", async () => {
    const accountId = `review-${crypto.randomUUID()}`;
    const started = await exports.default.fetch("https://worker.test/v1/review/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: accountId }),
    });
    expect(started.status).toBe(201);
    const startBody: unknown = await started.json();
    if (!isRecord(startBody) || typeof startBody.sessionId !== "string")
      throw new Error("Review start returned an invalid body");
    const sessionId = startBody.sessionId;
    const approve = () =>
      exports.default.fetch(`https://worker.test/v1/review/sessions/${sessionId}/approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account_id: accountId, allow: true }),
      });
    const first = await approve();
    const second = await approve();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody: unknown = await first.json();
    const secondBody: unknown = await second.json();
    if (
      !isRecord(firstBody) ||
      !Array.isArray(firstBody.events) ||
      !isRecord(secondBody) ||
      !Array.isArray(secondBody.events)
    )
      throw new Error("Review approval returned an invalid body");
    expect(firstBody.events).toHaveLength(7);
    expect(secondBody.events).toEqual(firstBody.events);
  });
});

describe("Admin Worker", () => {
  test("preserves diagnostics, delivery metadata, revoke, reconciliation, and audit contracts", async () => {
    const suffix = crypto.randomUUID();
    const account = controlAccountId(`account-${suffix}`);
    const device = controlDeviceId(`device-${suffix}`);
    const staffSubject = `staff-${suffix}`;
    const grantId = `grant-${suffix}`;
    const now = BigInt(Date.now());
    const store = env.ADMIN_CONTROL.getByName("control");
    await store.seedFixture({
      account: { accountId: account, status: "active", createdAtMs: now },
      devices: [
        {
          deviceId: device,
          accountId: account,
          kind: "HOST",
          name: "Test Host",
          publicKey: new Uint8Array(32),
          credentialGeneration: 1n,
          lastSeenAtMs: now,
        },
      ],
      entitlement: { kind: "active", usableUntilMs: now + 86_400_000n },
      grants: [
        {
          staffSubject,
          grantId,
          roles: ["support-read", "support-write", "billing-admin"],
          expiresAtMs: now + 600_000n,
        },
      ],
    });
    const headers = {
      ...protobufHeaders,
      "x-admin-subject": staffSubject,
      "x-admin-roles": "support-read,support-write,billing-admin",
      "x-admin-step-up-at-ms": now.toString(),
    };

    const denied = await exports.default.fetch("https://worker.test/v1/admin/account-diagnostics", {
      method: "POST",
      headers,
      body: toBinary(
        GetAccountDiagnosticsRequestSchema,
        create(GetAccountDiagnosticsRequestSchema, {
          accountId: account,
          supportAccessGrantId: "missing-grant",
        }),
      ),
    });
    expect(denied.status).toBe(403);

    const diagnosticsResponse = await exports.default.fetch(
      "https://worker.test/v1/admin/account-diagnostics",
      {
        method: "POST",
        headers,
        body: toBinary(
          GetAccountDiagnosticsRequestSchema,
          create(GetAccountDiagnosticsRequestSchema, {
            accountId: account,
            supportAccessGrantId: grantId,
          }),
        ),
      },
    );
    expect(diagnosticsResponse.status).toBe(200);
    const diagnostics = fromBinary(
      GetAccountDiagnosticsResponseSchema,
      new Uint8Array(await diagnosticsResponse.arrayBuffer()),
    );
    expect(diagnostics.entitlementState).toBe("active");
    expect(diagnostics.devices).toHaveLength(1);
    expect(diagnostics.devices[0]?.revoked).toBe(false);

    const deliveryResponse = await exports.default.fetch(
      "https://worker.test/v1/admin/delivery-metadata",
      {
        method: "POST",
        headers,
        body: toBinary(
          GetDeliveryMetadataRequestSchema,
          create(GetDeliveryMetadataRequestSchema, {
            accountId: account,
            deviceId: device,
            supportAccessGrantId: grantId,
          }),
        ),
      },
    );
    expect(deliveryResponse.status).toBe(200);
    const delivery = fromBinary(
      GetDeliveryMetadataResponseSchema,
      new Uint8Array(await deliveryResponse.arrayBuffer()),
    );
    expect(delivery).toMatchObject({
      queueCount: 0n,
      queueBytes: 0n,
      ackLag: 0n,
      homeRegion: "cloudflare",
    });

    const revokeResponse = await exports.default.fetch(
      "https://worker.test/v1/admin/revoke-device",
      {
        method: "POST",
        headers,
        body: toBinary(
          RevokeDeviceAsSupportRequestSchema,
          create(RevokeDeviceAsSupportRequestSchema, {
            accountId: account,
            deviceId: device,
            supportAccessGrantId: grantId,
          }),
        ),
      },
    );
    expect(revokeResponse.status).toBe(200);
    fromBinary(
      RevokeDeviceAsSupportResponseSchema,
      new Uint8Array(await revokeResponse.arrayBuffer()),
    );
    expect((await store.getDevice(device))?.revokedAtMs).toBeDefined();

    const reconciliationResponse = await exports.default.fetch(
      "https://worker.test/v1/admin/force-entitlement-reconciliation",
      {
        method: "POST",
        headers,
        body: toBinary(
          ForceEntitlementReconciliationRequestSchema,
          create(ForceEntitlementReconciliationRequestSchema, {
            accountId: account,
            supportAccessGrantId: grantId,
          }),
        ),
      },
    );
    expect(reconciliationResponse.status).toBe(200);
    expect(
      fromBinary(
        ForceEntitlementReconciliationResponseSchema,
        new Uint8Array(await reconciliationResponse.arrayBuffer()),
      ).jobId,
    ).not.toBe("");

    const legacy = await exports.default.fetch(
      `https://worker.test/api/diagnostics?account_id=${account}&grant_id=${grantId}`,
      { headers },
    );
    expect(legacy.status).toBe(200);
    const legacyBody: unknown = await legacy.json();
    expect(isRecord(legacyBody) && Array.isArray(legacyBody.devices)).toBe(true);
    const ui = await exports.default.fetch("https://worker.test/");
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("Relay control desk");
    expect(await store.listAuditActions()).toEqual(
      expect.arrayContaining([
        "GetAccountDiagnostics",
        "GetDeliveryMetadata",
        "RevokeDeviceAsSupport",
        "ForceEntitlementReconciliation",
      ]),
    );
  });
});

function envelope(
  messageId: string,
  recipientDeviceId: string,
  ciphertext: Uint8Array,
): OutboundEnvelope {
  const now = BigInt(Date.now());
  return create(OutboundEnvelopeSchema, {
    messageId,
    routeId: "route-test",
    senderDeviceId: "host-test",
    recipientDeviceId,
    clientSequence: 1n,
    createdAtMs: now,
    expiresAtMs: now + 300_000n,
    keyId: "key-test",
    nonce: new Uint8Array(24),
    ciphertext,
    priority: 1,
    notificationHint: 1,
  });
}

async function publish(envelopes: OutboundEnvelope[]): Promise<PublishResponse> {
  const response = await exports.default.fetch("https://worker.test/v1/relay/publish", {
    method: "POST",
    headers: protobufHeaders,
    body: toBinary(PublishRequestSchema, create(PublishRequestSchema, { envelopes })),
  });
  expect(response.status).toBe(200);
  return fromBinary(PublishResponseSchema, new Uint8Array(await response.arrayBuffer()));
}

async function acknowledge(
  recipientDeviceId: string,
  serverSequence: bigint,
): Promise<AckResponse> {
  const response = await exports.default.fetch("https://worker.test/v1/relay/ack", {
    method: "POST",
    headers: protobufHeaders,
    body: toBinary(
      AckRequestSchema,
      create(AckRequestSchema, { recipientDeviceId, serverSequence }),
    ),
  });
  expect(response.status).toBe(200);
  return fromBinary(AckResponseSchema, new Uint8Array(await response.arrayBuffer()));
}

async function subscribeFrame(
  recipientDeviceId: string,
  afterServerSequence: bigint,
): Promise<RelayFrame> {
  const upgrade = await exports.default.fetch(
    `https://worker.test/v1/relay/subscribe?recipient_device_id=${recipientDeviceId}&after=${afterServerSequence}&generation=test`,
    { headers: { upgrade: "websocket", "sec-websocket-protocol": "pocket-omp-relay" } },
  );
  if (upgrade.status !== 101 || upgrade.webSocket === null)
    throw new Error("WebSocket upgrade failed");
  const socket = upgrade.webSocket;
  socket.accept();
  try {
    return await new Promise<RelayFrame>((resolve, reject) => {
      socket.addEventListener("message", (event) => {
        void (async () => {
          const bytes =
            event.data instanceof ArrayBuffer
              ? new Uint8Array(event.data)
              : event.data instanceof Blob
                ? new Uint8Array(await event.data.arrayBuffer())
                : ArrayBuffer.isView(event.data)
                  ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
                  : undefined;
          if (bytes === undefined) throw new Error("Expected a binary relay frame");
          resolve(fromBinary(RelayFrameSchema, bytes));
        })().catch(reject);
      });
    });
  } finally {
    socket.close(1000, "test complete");
  }
}

function bytesBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function acceptedSequence(result: PublishResponse["results"][number] | undefined): bigint {
  if (result?.outcome.case !== "accepted") throw new Error("Expected an accepted publish result");
  return result.outcome.value.serverSequence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { exports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  OutboundEnvelopeSchema,
  type OutboundEnvelope,
  PublishRequestSchema,
  PublishResponseSchema,
  AckRequestSchema,
  GetSnapshotRequestSchema,
} from "@pocket-omp/proto/relay/v1";

// RELAY_AUTH_DISABLED=false — this suite exercises the production authorize()
// path end to end: JWT verification, claim validation, and per-route/device
// enforcement on every relay endpoint.

const jsonHeaders = { "content-type": "application/json" };
const protobufHeaders = { "content-type": "application/protobuf" };
const userHeaders = {
  ...jsonHeaders,
  "x-user-subject": "auth0|auth-test-user",
  "x-user-email": "auth@example.com",
};

interface PairedDevices {
  readonly routeId: string;
  readonly hostId: string;
  readonly hostCredential: string;
  readonly hostTicket: string;
  readonly mobileId: string;
  readonly mobileTicket: string;
}

async function pairAndTicket(): Promise<PairedDevices> {
  const begin = await exports.default.fetch("https://worker.test/v1/pairings", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      host_name: "auth-host",
      host_public_key: hex(crypto.getRandomValues(new Uint8Array(32))),
    }),
  });
  const pairing: unknown = await begin.json();
  if (
    !isRecord(pairing) ||
    typeof pairing.pairing_id !== "string" ||
    typeof pairing.watch_secret !== "string" ||
    typeof pairing.challenge !== "string"
  )
    throw new Error("pairing failed");
  const claim = await exports.default.fetch(
    `https://worker.test/v1/pairings/${pairing.pairing_id}/claim`,
    {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        mobile_public_key: hex(crypto.getRandomValues(new Uint8Array(32))),
        challenge: pairing.challenge,
      }),
    },
  );
  const claimed: unknown = await claim.json();
  if (
    !isRecord(claimed) ||
    typeof claimed.route_id !== "string" ||
    typeof claimed.device_id !== "string" ||
    typeof claimed.device_credential !== "string"
  )
    throw new Error("claim failed");
  const hostComplete = await exports.default.fetch(
    `https://worker.test/v1/pairings/${pairing.pairing_id}/complete`,
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ actor: "host", watch_secret: pairing.watch_secret }),
    },
  );
  const host: unknown = await hostComplete.json();
  if (
    !isRecord(host) ||
    typeof host.host_id !== "string" ||
    typeof host.device_credential !== "string"
  )
    throw new Error("host completion failed");

  const issueTicket = async (deviceId: string, credential: string): Promise<string> => {
    const response = await exports.default.fetch("https://worker.test/v1/relay-tickets", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${credential}` },
      body: JSON.stringify({ device_id: deviceId }),
    });
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.ticket !== "string")
      throw new Error("ticket issuance failed");
    return body.ticket;
  };
  return {
    routeId: claimed.route_id,
    hostId: host.host_id,
    hostCredential: host.device_credential,
    hostTicket: await issueTicket(host.host_id, host.device_credential),
    mobileId: claimed.device_id,
    mobileTicket: await issueTicket(claimed.device_id, claimed.device_credential),
  };
}

function envelope(
  senderDeviceId: string,
  recipientDeviceId: string,
  routeId: string,
): OutboundEnvelope {
  const now = BigInt(Date.now());
  return create(OutboundEnvelopeSchema, {
    messageId: `auth-${crypto.randomUUID()}`,
    routeId,
    senderDeviceId,
    recipientDeviceId,
    keyId: "key-auth",
    clientSequence: 1n,
    createdAtMs: now,
    expiresAtMs: now + 600_000n,
    nonce: crypto.getRandomValues(new Uint8Array(24)),
    ciphertext: new Uint8Array([1, 2, 3]),
    priority: 1,
    notificationHint: 1,
  });
}

async function publish(item: OutboundEnvelope, ticket?: string): Promise<Response> {
  return exports.default.fetch("https://worker.test/v1/relay/publish", {
    method: "POST",
    headers: {
      ...protobufHeaders,
      ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
    },
    body: toBinary(PublishRequestSchema, create(PublishRequestSchema, { envelopes: [item] })),
  });
}

describe("Relay authorization (auth enabled)", () => {
  test("accepts a valid ticket and delivers the envelope", async () => {
    const devices = await pairAndTicket();
    const response = await publish(
      envelope(devices.hostId, devices.mobileId, devices.routeId),
      devices.hostTicket,
    );
    expect(response.status).toBe(200);
    const body = fromBinary(PublishResponseSchema, new Uint8Array(await response.arrayBuffer()));
    expect(body.results[0]?.outcome.case).toBe("accepted");
  });

  test("rejects a missing ticket with 401", async () => {
    const devices = await pairAndTicket();
    const response = await publish(envelope(devices.hostId, devices.mobileId, devices.routeId));
    expect(response.status).toBe(401);
  });

  test("rejects a ticket whose subject does not match the sender with 403", async () => {
    const devices = await pairAndTicket();
    // The mobile's ticket is used to publish with the host as sender.
    const response = await publish(
      envelope(devices.hostId, devices.mobileId, devices.routeId),
      devices.mobileTicket,
    );
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("error body is invalid");
    expect(body.code).toBe("SENDER_MISMATCH");
  });

  test("rejects publishing to a route the ticket never granted with 403", async () => {
    const devices = await pairAndTicket();
    const response = await publish(
      envelope(devices.hostId, devices.mobileId, "route-not-granted"),
      devices.hostTicket,
    );
    expect(response.status).toBe(403);
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new Error("error body is invalid");
    expect(body.code).toBe("ROUTE_NOT_GRANTED");
  });

  test("rejects ack and snapshot access to another device's mailbox with 403", async () => {
    const devices = await pairAndTicket();
    // The host ticket cannot ack the mobile's mailbox.
    const ack = await exports.default.fetch("https://worker.test/v1/relay/ack", {
      method: "POST",
      headers: {
        ...protobufHeaders,
        authorization: `Bearer ${devices.hostTicket}`,
      },
      body: toBinary(
        AckRequestSchema,
        create(AckRequestSchema, {
          recipientDeviceId: devices.mobileId,
          serverSequence: 1n,
        }),
      ),
    });
    expect(ack.status).toBe(403);

    const snapshot = await exports.default.fetch("https://worker.test/v1/relay/snapshot", {
      method: "POST",
      headers: {
        ...protobufHeaders,
        authorization: `Bearer ${devices.hostTicket}`,
      },
      body: toBinary(
        GetSnapshotRequestSchema,
        create(GetSnapshotRequestSchema, { recipientDeviceId: devices.mobileId }),
      ),
    });
    expect(snapshot.status).toBe(403);
  });

  test("rejects a revoked device's previously issued ticket", async () => {
    const devices = await pairAndTicket();
    const revoke = await exports.default.fetch(
      `https://worker.test/v1/devices/${devices.hostId}/revoke`,
      {
        method: "POST",
        headers: userHeaders,
      },
    );
    expect(revoke.status).toBe(200);
    const response = await publish(
      envelope(devices.hostId, devices.mobileId, devices.routeId),
      devices.hostTicket,
    );
    // Revocation bumps credential_generation, so the live ticket must die
    // immediately rather than living out its 600s lifetime.
    expect(response.status).toBe(401);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

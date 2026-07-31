import { create } from "@bufbuild/protobuf";
import {
  type AckRequest,
  AckRequestSchema,
  AckResponseSchema,
  type AckResponse,
  DeliveredEnvelopeSchema,
  NotificationHint,
  type OutboundEnvelope,
  OutboundEnvelopeSchema,
  Priority,
  type PublishRequest,
  PublishResponseSchema,
  type PublishResponse,
  RelayFrameSchema,
  type SealedEnvelope,
  SealedEnvelopeSchema,
  type SubscribeRequest,
  type RelayFrame,
} from "@pocket-omp/proto/relay/v1";
import { expect, test } from "bun:test";
import {
  RelayGatewayError,
  RouteRelayGateway,
  type RelayGatewayClient,
} from "../src/relay-gateway";

class FakeRelayClient implements RelayGatewayClient {
  public readonly subscribeRequests: SubscribeRequest[] = [];
  public readonly publishRequests: PublishRequest[] = [];
  public readonly ackRequests: AckRequest[] = [];
  public frames: readonly RelayFrame[] = [];

  public async *subscribe(
    request: SubscribeRequest,
    _signal: AbortSignal,
  ): AsyncIterable<RelayFrame> {
    this.subscribeRequests.push(request);
    for (const frame of this.frames) yield frame;
  }

  public async publish(request: PublishRequest): Promise<PublishResponse> {
    this.publishRequests.push(request);
    return create(PublishResponseSchema, { results: [], acceptedAckServerSequence: 0n });
  }

  public async acknowledge(request: AckRequest): Promise<AckResponse> {
    this.ackRequests.push(request);
    return create(AckResponseSchema, { acceptedServerSequence: request.serverSequence });
  }
}

function outboundEnvelope(overrides: Partial<OutboundEnvelope> = {}): OutboundEnvelope {
  return create(OutboundEnvelopeSchema, {
    messageId: "message-1",
    routeId: "route-1",
    senderDeviceId: "host-1",
    recipientDeviceId: "mobile-1",
    clientSequence: 1n,
    createdAtMs: 1_800_000_000_000n,
    expiresAtMs: 1_800_000_600_000n,
    keyId: "key-1",
    nonce: new Uint8Array(24).fill(1),
    ciphertext: new Uint8Array([1, 2, 3]),
    priority: Priority.NORMAL,
    notificationHint: NotificationHint.NONE,
    ...overrides,
  });
}

function sealedEnvelope(envelope: OutboundEnvelope): SealedEnvelope {
  return create(SealedEnvelopeSchema, {
    messageId: envelope.messageId,
    routeId: envelope.routeId,
    senderDeviceId: envelope.senderDeviceId,
    recipientDeviceId: envelope.recipientDeviceId,
    clientSequence: envelope.clientSequence,
    createdAtMs: envelope.createdAtMs,
    expiresAtMs: envelope.expiresAtMs,
    keyId: envelope.keyId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    priority: envelope.priority,
    notificationHint: envelope.notificationHint,
  });
}

function envelopeFrame(serverSequence: bigint, envelope: OutboundEnvelope): RelayFrame {
  return create(RelayFrameSchema, {
    body: {
      case: "envelope",
      value: create(DeliveredEnvelopeSchema, {
        serverSequence,
        envelope: sealedEnvelope(envelope),
      }),
    },
  });
}

test("subscribe issues a SubscribeRequest scoped to the recipientDeviceId and maps envelope frames", async () => {
  const client = new FakeRelayClient();
  client.frames = [envelopeFrame(5n, outboundEnvelope())];
  const gateway = new RouteRelayGateway({ client, recipientDeviceId: "host-1" });

  const results: unknown[] = [];
  for await (const value of gateway.subscribe(2n, new AbortController().signal))
    results.push(value);

  expect(client.subscribeRequests).toHaveLength(1);
  expect(client.subscribeRequests[0]?.recipientDeviceId).toBe("host-1");
  expect(client.subscribeRequests[0]?.afterServerSequence).toBe(2n);
  expect(results).toEqual([
    { messageId: "message-1", serverSequence: 5n, encrypted: sealedEnvelope(outboundEnvelope()) },
  ]);
});

test("subscribe silently skips non-envelope relay frames", async () => {
  const client = new FakeRelayClient();
  client.frames = [
    create(RelayFrameSchema, { body: { case: "heartbeat", value: { serverTimeMs: 1n } } }),
    envelopeFrame(1n, outboundEnvelope({ messageId: "message-2" })),
  ];
  const gateway = new RouteRelayGateway({ client, recipientDeviceId: "host-1" });

  const results: unknown[] = [];
  for await (const value of gateway.subscribe(0n, new AbortController().signal))
    results.push(value);
  expect(results).toHaveLength(1);
});

test("publish converts outbox items into OutboundEnvelope protos and forwards ackServerSequence", async () => {
  const client = new FakeRelayClient();
  const gateway = new RouteRelayGateway({ client, recipientDeviceId: "host-1" });
  await gateway.publish([{ messageId: "message-1", encrypted: outboundEnvelope() }], 3n);
  expect(client.publishRequests).toHaveLength(1);
  expect(client.publishRequests[0]?.envelopes).toEqual([outboundEnvelope()]);
  expect(client.publishRequests[0]?.ackServerSequence).toBe(3n);
});

test("publish rejects an item whose encrypted payload is not a sealed envelope", async () => {
  const client = new FakeRelayClient();
  const gateway = new RouteRelayGateway({ client, recipientDeviceId: "host-1" });
  expect(
    gateway.publish([{ messageId: "m1", encrypted: { not: "an envelope" } }]),
  ).rejects.toBeInstanceOf(RelayGatewayError);
});

test("acknowledge sends an AckRequest for this gateway's recipientDeviceId", async () => {
  const client = new FakeRelayClient();
  const gateway = new RouteRelayGateway({ client, recipientDeviceId: "host-1" });
  await gateway.acknowledge(7n);
  expect(client.ackRequests).toEqual([
    create(AckRequestSchema, { recipientDeviceId: "host-1", serverSequence: 7n }),
  ]);
});

test("constructor rejects an empty recipientDeviceId", () => {
  const client = new FakeRelayClient();
  expect(() => new RouteRelayGateway({ client, recipientDeviceId: "" })).toThrow(RelayGatewayError);
});

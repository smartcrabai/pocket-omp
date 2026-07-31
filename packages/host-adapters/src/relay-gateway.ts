// RelayGateway (host-core) implementation wrapping WorkerRelayClient
// (packages/relay-client). Scoped to a single paired route: `recipientDeviceId`
// is this Host's own relay device id for that route (issued during pairing,
// see apps/host/src/pairing.ts's `route:<routeId>:host-id`), used both to
// subscribe to this Host's mailbox and to publish/acknowledge against it.
//
// Relay ticket acquisition/refresh is out of scope here: WorkerRelayClient
// already accepts a `ticket` provider function at construction time
// (packages/relay-client/src/index.ts), so the composition root
// (apps/host) is responsible for constructing the WorkerRelayClient with a
// ticket provider backed by apps/host/src/control-client.ts.

import { create } from "@bufbuild/protobuf";
import type { RelayGateway } from "@pocket-omp/host-core";
import {
  AckRequestSchema,
  PublishRequestSchema,
  SubscribeRequestSchema,
} from "@pocket-omp/proto/relay/v1";
import type { WorkerRelayClient } from "@pocket-omp/relay-client";

import { outboundEnvelopeFromUnknown } from "./relay-envelope-codec";

const SUBSCRIBE_PROTOCOL_VERSION = 1;

// Only the three RPCs this gateway actually calls, rather than the full
// WorkerRelayClient surface: keeps the dependency minimal and lets tests
// inject a lightweight fake instead of a real WorkerRelayClient (which pins
// its socket/fetch transport behind private fields).
export type RelayGatewayClient = Pick<WorkerRelayClient, "subscribe" | "publish" | "acknowledge">;

export interface RouteRelayGatewayOptions {
  readonly client: RelayGatewayClient;
  readonly recipientDeviceId: string;
  readonly newConnectionGeneration?: () => string;
}

export class RouteRelayGateway implements RelayGateway {
  private readonly client: RelayGatewayClient;
  private readonly recipientDeviceId: string;
  private readonly connectionGeneration: string;

  public constructor(options: RouteRelayGatewayOptions) {
    if (options.recipientDeviceId.length === 0) {
      throw new RelayGatewayError("INVALID_DEVICE_ID", "recipientDeviceId must not be empty");
    }
    this.client = options.client;
    this.recipientDeviceId = options.recipientDeviceId;
    this.connectionGeneration = options.newConnectionGeneration?.() ?? crypto.randomUUID();
  }

  public async *subscribe(
    afterServerSequence: bigint,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    const request = create(SubscribeRequestSchema, {
      recipientDeviceId: this.recipientDeviceId,
      afterServerSequence,
      connectionGeneration: this.connectionGeneration,
      protocolVersion: SUBSCRIBE_PROTOCOL_VERSION,
    });
    for await (const frame of this.client.subscribe(request, signal)) {
      // Heartbeat/Reauthenticate/ResetRequired/StreamSuperseded frames are
      // intentionally ignored here: HostRelayCoordinator's receive() loop
      // only understands envelope deliveries (see host-core's
      // hostInboundEnvelope validator). Reacting to a retention-gap reset or
      // a superseded connection generation is future work, tracked
      // alongside wiring this gateway into HostDaemon.
      if (frame.body.case !== "envelope") continue;
      const delivered = frame.body.value;
      if (delivered.envelope === undefined) continue;
      yield {
        messageId: delivered.envelope.messageId,
        serverSequence: delivered.serverSequence,
        encrypted: delivered.envelope,
      };
    }
  }

  public async publish(
    envelopes: readonly unknown[],
    ackServerSequence?: bigint,
  ): Promise<unknown> {
    // host-core's HostRelayCoordinator.flushOutbox() passes its pendingOutbox
    // batch straight through, i.e. each element here is a HostOutboxItem
    // (`{ messageId, encrypted }`), not a bare encrypted envelope.
    const request = create(PublishRequestSchema, {
      envelopes: envelopes.map((item) =>
        outboundEnvelopeFromUnknown(
          hostOutboxItemEncrypted(item),
          (message) => new RelayGatewayError("INVALID_OUTBOX_ITEM", message),
        ),
      ),
      ...(ackServerSequence === undefined ? {} : { ackServerSequence }),
    });
    return this.client.publish(request);
  }

  public async acknowledge(serverSequence: bigint): Promise<void> {
    const request = create(AckRequestSchema, {
      recipientDeviceId: this.recipientDeviceId,
      serverSequence,
    });
    await this.client.acknowledge(request);
  }
}

function hostOutboxItemEncrypted(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("encrypted" in value)) {
    throw new RelayGatewayError(
      "INVALID_OUTBOX_ITEM",
      "Outbox item is missing an encrypted payload",
    );
  }
  return value.encrypted;
}

export class RelayGatewayError extends Error {
  public constructor(
    public readonly code: "INVALID_DEVICE_ID" | "INVALID_OUTBOX_ITEM",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RelayGatewayError";
  }
}

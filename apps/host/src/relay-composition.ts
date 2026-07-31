// Composition root wiring HostRelayCoordinator (packages/host-core) from
// the concrete adapters in packages/host-adapters, plus this route's relay
// ticket / relay origin (via ./control-client.ts and ./relay-ticket-cache.ts).
//
// Out of scope for this task (tracked as follow-ups):
//   - Wiring the resulting coordinator into HostDaemon (starting
//     receive()/flushOutbox() loops, plumbing an AbortSignal for shutdown).
//   - Real command dispatch: see ./stub-command-dispatcher.ts.
// This module only builds a HostRelayCoordinator that CAN be started.
import type { RandomSource } from "@pocket-omp/crypto";
import {
  HostSqliteDeliveryStore,
  RouteEnvelopeCrypto,
  RouteRelayGateway,
} from "@pocket-omp/host-adapters";
import { HostRelayCoordinator, type SecureKeyStore } from "@pocket-omp/host-core";
import { WorkerRelayClient, type RelayClientOptions } from "@pocket-omp/relay-client";

import { ControlClient } from "./control-client";
import { RecipientDeviceIdLearner, learningEnvelopeCrypto } from "./recipient-device-id-learner";
import { RelayTicketCache } from "./relay-ticket-cache";
import { createStubCommandDispatcher, type InboundDispatchEvent } from "./stub-command-dispatcher";

export interface BuildHostRelayCoordinatorOptions {
  readonly routeId: string;
  readonly controlOrigin: URL;
  readonly keyStore: SecureKeyStore;
  /** SQLite database path for HostSqliteDeliveryStore; defaults to ":memory:". */
  readonly dbPath?: string;
  readonly fetch?: typeof fetch;
  readonly webSocket?: typeof WebSocket;
  readonly random?: RandomSource;
  readonly now?: () => bigint;
  readonly newMessageId?: (recipientDeviceId: string, plaintext: Uint8Array) => string;
  readonly ticketRefreshMarginMs?: bigint;
  readonly onUnsupportedInbound?: (event: InboundDispatchEvent) => void;
  /**
   * Seeds the paired Mobile device id up front instead of waiting to learn
   * it from an authenticated inbound envelope (see
   * ./recipient-device-id-learner.ts for why Host cannot look this up via
   * Control API today). Optional: when omitted, `recipientDeviceId()` on the
   * returned composition returns undefined until the first authenticated
   * inbound message is received on this route.
   */
  readonly initialRecipientDeviceId?: string;
}

export interface HostRelayComposition {
  readonly coordinator: HostRelayCoordinator;
  readonly store: HostSqliteDeliveryStore;
  readonly ticketCache: RelayTicketCache;
  /** This route's own Host device id (SecureKeyStore's `route:<routeId>:host-id`). */
  readonly hostId: string;
  /** The paired Mobile device id to address outbound events at, or undefined if not yet known (see ./recipient-device-id-learner.ts). */
  readonly recipientDeviceId: () => string | undefined;
  close(): void;
}

export async function buildHostRelayCoordinator(
  options: BuildHostRelayCoordinatorOptions,
): Promise<HostRelayComposition> {
  if (options.routeId.length === 0) {
    throw new HostRelayCompositionError("INVALID_ROUTE", "routeId must not be empty");
  }
  const { hostDeviceId, deviceCredential, recipientDeviceId } = await pairedRouteIdentity(
    options.keyStore,
    options.routeId,
  );

  const controlClient = new ControlClient({
    origin: options.controlOrigin,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const ticketCache = new RelayTicketCache({
    issue: () =>
      controlClient.issueRelayTicket({
        deviceId: hostDeviceId,
        deviceCredential,
        routeIds: [options.routeId],
      }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ticketRefreshMarginMs === undefined
      ? {}
      : { refreshMarginMs: options.ticketRefreshMarginMs }),
  });
  // The relay origin comes back on the ticket response itself (it is the
  // route's home region, services/control-api/src/control.ts's
  // `relay_origin`), so a ticket must be fetched at least once before a
  // WorkerRelayClient can be constructed (its baseUrl is fixed at
  // construction time). This makes composition require network access;
  // that trade-off is acceptable for "buildable" scope, but a future task
  // wiring this into HostDaemon's startup should reconsider retry/backoff
  // behavior here.
  const relayOrigin = await ticketCache.relayOrigin();

  const relayClientOptions: RelayClientOptions = {
    baseUrl: relayOrigin,
    ticket: () => ticketCache.ticket(),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.webSocket === undefined ? {} : { webSocket: options.webSocket }),
  };
  const relayClient = new WorkerRelayClient(relayClientOptions);
  const relay = new RouteRelayGateway({ client: relayClient, recipientDeviceId: hostDeviceId });

  const store = new HostSqliteDeliveryStore(options.dbPath ?? ":memory:");

  const envelopeCrypto = new RouteEnvelopeCrypto({
    routeId: options.routeId,
    keyStore: options.keyStore,
    random: options.random ?? defaultRandomSource(),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.newMessageId === undefined ? {} : { newMessageId: options.newMessageId }),
  });

  const dispatcher = createStubCommandDispatcher(
    options.onUnsupportedInbound === undefined ? {} : { onInbound: options.onUnsupportedInbound },
  );

  // Prefer the peer device id persisted at pairing time (Control API's
  // /v1/routes/:id/recipient-device-id); an explicit option still overrides it,
  // and the learner remains the fallback when neither is available.
  const recipientLearner = new RecipientDeviceIdLearner(
    options.initialRecipientDeviceId ?? recipientDeviceId,
  );
  const coordinator = new HostRelayCoordinator(
    relay,
    store,
    learningEnvelopeCrypto(envelopeCrypto, recipientLearner),
    dispatcher,
  );
  return {
    coordinator,
    store,
    ticketCache,
    hostId: hostDeviceId,
    recipientDeviceId: () => recipientLearner.current,
    close: () => store.close(),
  };
}

async function pairedRouteIdentity(
  keyStore: SecureKeyStore,
  routeId: string,
): Promise<{
  readonly hostDeviceId: string;
  readonly deviceCredential: string;
  readonly recipientDeviceId: string | undefined;
}> {
  const [hostIdBytes, credentialBytes, recipientBytes] = await Promise.all([
    keyStore.get(routeHandle(routeId, "host-id")),
    keyStore.get(routeHandle(routeId, "device-credential")),
    keyStore.get(routeHandle(routeId, "recipient-device-id")),
  ]);
  if (hostIdBytes === undefined) {
    throw new HostRelayCompositionError(
      "NOT_PAIRED",
      `No host device id is stored for route ${routeId}`,
    );
  }
  if (credentialBytes === undefined) {
    throw new HostRelayCompositionError(
      "NOT_PAIRED",
      `No device credential is stored for route ${routeId}`,
    );
  }
  const hostDeviceId = new TextDecoder().decode(hostIdBytes);
  const deviceCredential = new TextDecoder().decode(credentialBytes);
  if (hostDeviceId.length === 0 || deviceCredential.length === 0) {
    throw new HostRelayCompositionError(
      "NOT_PAIRED",
      `Stored pairing identity for route ${routeId} is empty`,
    );
  }
  // Absent for routes paired before Control API exposed the peer device id;
  // those fall back to learning it from an authenticated inbound envelope.
  const stored = recipientBytes === undefined ? "" : new TextDecoder().decode(recipientBytes);
  return {
    hostDeviceId,
    deviceCredential,
    recipientDeviceId: stored.length === 0 ? undefined : stored,
  };
}

function defaultRandomSource(): RandomSource {
  return { bytes: (length) => crypto.getRandomValues(new Uint8Array(length)) };
}

function routeHandle(routeId: string, field: string): string {
  return `route:${routeId}:${field}`;
}

export class HostRelayCompositionError extends Error {
  public constructor(
    public readonly code: "INVALID_ROUTE" | "NOT_PAIRED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostRelayCompositionError";
  }
}

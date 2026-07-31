// Resolves the paired Mobile device's device_id -- the `recipientDeviceId`
// HostRelayCoordinator.enqueue() needs to address an outbound event at.
//
// UPDATE (follow-up to the investigation below): the Control Plane gap is
// now closed. `completePairingAsHost`'s response (services/control-api/src/
// control.ts's `completePairing`) now includes `recipient_device_id`
// (apps/host/src/pairing.ts persists it to the SecureKeyStore as
// `route:<routeId>:recipient-device-id` right after pairing), and
// `ControlClient.getRouteRecipientDevice` (POST
// /v1/routes/:routeId/recipient-device-id, authenticated the same way
// issueRelayTicket is, via the device's own bearer credential) lets an
// already-paired Host recover it later if the persisted value is ever
// missing (e.g. a pairing that predates that field, or local storage that
// lost the key). Composing code seeds `RecipientDeviceIdLearner` from
// whichever of those the caller already has (see
// `BuildHostRelayCoordinatorOptions.initialRecipientDeviceId` in
// ./relay-composition.ts) instead of leaving it undefined.
//
// This learner remains as the runtime fallback/self-healing path below, kept
// deliberately unchanged (this module's exports are consumed by
// ./relay-composition.ts and ./host-daemon.ts, which are out of scope for
// the change that closed the gap): it costs nothing to keep running, and it
// covers the case where the Control-Plane-sourced value was never seeded
// (composition root passed no `initialRecipientDeviceId`) or is stale
// relative to reality (e.g. Mobile re-pairs a route out from under a Host
// that hasn't refreshed its stored value). Original investigation, preserved
// for context:
//   - completePairingAsHost's response used to be
//     `{ host_id, route_id, device_credential, state }` -- no mobile
//     device_id.
//   - watchPairing's response never surfaced it to the Host actor either
//     (claimPairing returns the mobile device_id, but only to Mobile itself,
//     in the same HTTP response as its own device_credential).
//   - `/v1/devices` (listDevices) exists and *would* return it, but is
//     authenticated via authenticateUser (a logged-in user's own bearer
//     token/OAuth identity) -- the Host process never holds one of those; it
//     only ever authenticates as itself via its own device_credential
//     bearer token (see ControlClient.issueRelayTicket).
//
// Stopgap kept as a fallback: learn recipientDeviceId from the
// sender_device_id of the first (and every subsequent) successfully
// AEAD-authenticated inbound envelope on this route. senderDeviceId is part
// of the envelope metadata fed into the AEAD's AAD (packages/crypto's
// canonicalEnvelopeAad, via session-protocol's toCryptoEnvelopeMetadata), so
// once HostEnvelopeCrypto.open() returns successfully, the senderDeviceId it
// read off that envelope is cryptographically guaranteed to have been sent
// by whoever holds this route's pairwise key -- i.e. genuinely the paired
// Mobile device, not a spoofed value from an unauthenticated envelope.
// Learning only ever happens *after* a successful open(), never from an
// envelope that hasn't been authenticated yet.
//
// Trade-off when no initial value is seeded: Host cannot forward any event
// before Mobile has sent at least one authenticated message on this route
// (its initial device-hello is expected to be that first message in
// practice). That is a one-time bootstrap gap per route/process lifetime,
// not a per-event one -- once learned, the id is retained for the life of
// this learner instance. Callers that already know the recipient out of band
// (the Control-Plane-sourced value described above, or any other
// config-provided value) should seed it via the constructor instead of
// waiting to learn it.
import type {
  HostEnvelopeCrypto,
  HostInboundEnvelope,
  HostOutboxItem,
} from "@pocket-omp/host-core";

export class RecipientDeviceIdLearner {
  #current: string | undefined;

  public constructor(initial?: string) {
    this.#current = initial;
  }

  public get current(): string | undefined {
    return this.#current;
  }

  public learn(deviceId: string): void {
    if (deviceId.length > 0) this.#current = deviceId;
  }
}

/**
 * Wraps a HostEnvelopeCrypto so every envelope it successfully opens teaches
 * `learner` that envelope's authenticated senderDeviceId. seal() is passed
 * through unchanged.
 */
export function learningEnvelopeCrypto(
  crypto: HostEnvelopeCrypto,
  learner: RecipientDeviceIdLearner,
): HostEnvelopeCrypto {
  return {
    seal: (recipientDeviceId: string, plaintext: Uint8Array): Promise<HostOutboxItem> =>
      crypto.seal(recipientDeviceId, plaintext),
    open: async (envelope: HostInboundEnvelope): Promise<Uint8Array> => {
      const plaintext = await crypto.open(envelope);
      const senderDeviceId = senderDeviceIdOf(envelope.encrypted);
      if (senderDeviceId !== undefined) learner.learn(senderDeviceId);
      return plaintext;
    },
  };
}

// envelope.encrypted is declared `unknown` at the host-core boundary
// (HostInboundEnvelope); this duck-types the two shapes RouteRelayGateway
// can hand back (see packages/host-adapters/src/relay-gateway.ts's
// subscribe(): a bare SealedEnvelope-like object, or one already unwrapped
// from a DeliveredEnvelope) without asserting either shape.
function senderDeviceIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const direct = Reflect.get(value, "senderDeviceId");
  if (typeof direct === "string" && direct.length > 0) return direct;
  const wrapped = Reflect.get(value, "envelope");
  if (typeof wrapped === "object" && wrapped !== null) {
    const inner = Reflect.get(wrapped, "senderDeviceId");
    if (typeof inner === "string" && inner.length > 0) return inner;
  }
  return undefined;
}

import { isValidDeviceCredential, isValidDeviceId } from "./credential-validation";

// Mirrors TICKET_LIFETIME_SECONDS in services/control-api/src/control.ts.
export const RELAY_TICKET_LIFETIME_SECONDS = 600;

// Safety margin subtracted from the ticket's expiry before it is considered
// stale: 60s is 10% of the 600s lifetime, which comfortably covers request
// latency and client/server clock drift while still reusing ~90% of each
// ticket's validity window instead of re-requesting on every use.
export const RELAY_TICKET_REFRESH_MARGIN_MS = 60_000;

export interface DeviceCredentialInput {
  readonly deviceId: string;
  readonly credential: string;
}

export interface RelayTicket {
  readonly ticket: string;
  readonly relayOrigin: string;
  readonly expiresAtMs: number;
  readonly routeEpoch: string;
}

interface RelayTicketRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface RelayTicketFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

// A narrowed subset of the global `fetch` signature so tests can inject a
// stub without needing a DOM Response instance, and so this module never
// touches a global directly.
export type RelayTicketFetch = (
  input: string,
  init: RelayTicketRequestInit,
) => Promise<RelayTicketFetchResponse>;

export interface RelayTicketClientDeps {
  readonly fetch: RelayTicketFetch;
  readonly now: () => number;
  readonly controlUrl: string;
}

export class RelayTicketRequestError extends Error {
  public readonly status: number;

  public constructor(status: number, message?: string) {
    super(message ?? `Relay ticket request failed with status ${status}`);
    this.name = "RelayTicketRequestError";
    this.status = status;
  }
}

// A distinct subtype for 401/403: an invalid or revoked device credential
// will never succeed by retrying, unlike a transient 5xx.
export class RelayTicketAuthError extends RelayTicketRequestError {
  public constructor(status: number) {
    super(status, "Device credential was rejected by the Control Plane");
    this.name = "RelayTicketAuthError";
  }
}

export function relayTicketNeedsRefresh(
  ticket: RelayTicket,
  nowMs: number,
  marginMs: number = RELAY_TICKET_REFRESH_MARGIN_MS,
): boolean {
  return ticket.expiresAtMs - marginMs <= nowMs;
}

export class RelayTicketClient {
  #cached: RelayTicket | undefined;

  public constructor(private readonly deps: RelayTicketClientDeps) {}

  // Returns the cached ticket unless it is absent or within the refresh
  // margin of expiry, in which case a fresh one is requested and cached.
  public async getTicket(
    credential: DeviceCredentialInput,
    routeIds?: readonly string[],
  ): Promise<RelayTicket> {
    const cached = this.#cached;
    if (cached !== undefined && !relayTicketNeedsRefresh(cached, this.deps.now())) return cached;
    const ticket = await requestRelayTicket(this.deps, credential, routeIds);
    this.#cached = ticket;
    return ticket;
  }

  // Forces the next getTicket() call to fetch a fresh ticket, e.g. after the
  // caller observes the relay reject the cached ticket out of band.
  public invalidate(): void {
    this.#cached = undefined;
  }
}

export async function requestRelayTicket(
  deps: RelayTicketClientDeps,
  credential: DeviceCredentialInput,
  routeIds?: readonly string[],
): Promise<RelayTicket> {
  if (!isValidDeviceId(credential.deviceId) || !isValidDeviceCredential(credential.credential))
    throw new Error("Device credential is invalid");
  const response = await deps.fetch(`${deps.controlUrl}/v1/relay-tickets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      device_id: credential.deviceId,
      route_ids: routeIds ?? [],
    }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new RelayTicketAuthError(response.status);
    throw new RelayTicketRequestError(response.status);
  }
  return parseRelayTicketResponse(await response.json());
}

function parseRelayTicketResponse(value: unknown): RelayTicket {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ticket" in value) ||
    typeof value.ticket !== "string" ||
    value.ticket.length === 0 ||
    !("relay_origin" in value) ||
    typeof value.relay_origin !== "string" ||
    value.relay_origin.length === 0 ||
    !("expires_at_ms" in value) ||
    typeof value.expires_at_ms !== "number" ||
    !("route_epoch" in value) ||
    typeof value.route_epoch !== "string" ||
    value.route_epoch.length === 0
  )
    // Deliberately generic: the raw response body (which may embed the
    // ticket) must never be interpolated into an error message.
    throw new Error("Relay ticket response is invalid");
  return {
    ticket: value.ticket,
    relayOrigin: value.relay_origin,
    expiresAtMs: value.expires_at_ms,
    routeEpoch: value.route_epoch,
  };
}

// Thin HTTP client for the Control Plane pairing endpoints implemented in
// services/control-api/src/control.ts (beginPairing / watchPairing /
// completePairing). `fetch` is always injected so tests can substitute a fake
// without touching global state, matching the `fetcher` pattern used by
// ./updater.ts.

export interface ControlClientOptions {
  readonly origin: URL;
  readonly fetch?: typeof fetch;
}

export interface BeginPairingInput {
  readonly hostName: string;
  readonly hostPublicKey: Uint8Array;
}

export interface BeginPairingResult {
  readonly pairingId: string;
  readonly challenge: Uint8Array;
  readonly watchSecret: string;
  readonly expiresAtMs: bigint;
  readonly serviceIdentifier: string;
}

export interface WatchPairingResult {
  readonly pairingId: string;
  readonly state: string;
  readonly hostName: string;
  readonly mobilePublicKey?: Uint8Array;
  readonly routeId?: string;
  readonly hostConfirmed: boolean;
  readonly mobileConfirmed: boolean;
  readonly expiresAtMs: bigint;
}

export interface CompletePairingHostResult {
  readonly hostId: string;
  readonly routeId: string;
  readonly deviceCredential: string;
  readonly state: string;
  /**
   * The paired Mobile device's device_id -- the recipientDeviceId
   * HostRelayCoordinator addresses outbound events at (see
   * ./recipient-device-id-learner.ts). Undefined when talking to a
   * control-api deployment that predates this field: pairing itself already
   * succeeded server-side by the time this response is parsed, so a missing
   * field here must not fail the whole pairing attempt. Callers should try
   * `getRouteRecipientDevice` as a backfill and otherwise fall back to
   * RecipientDeviceIdLearner's runtime learning path.
   */
  readonly recipientDeviceId?: string;
}

export interface IssueRelayTicketInput {
  readonly deviceId: string;
  readonly deviceCredential: string;
  readonly routeIds?: readonly string[];
}

export interface GetRouteRecipientDeviceInput {
  readonly routeId: string;
  /** The caller's own device_id (the Host's own device_id when called from the Host). */
  readonly deviceId: string;
  readonly deviceCredential: string;
}

export interface IssueRelayTicketResult {
  readonly ticket: string;
  readonly relayOrigin: string;
  readonly expiresAtMs: bigint;
  readonly routeEpoch: bigint;
}

export class ControlClient {
  private readonly origin: URL;
  private readonly fetcher: typeof fetch;

  public constructor(options: ControlClientOptions) {
    this.origin = options.origin;
    this.fetcher = options.fetch ?? fetch;
  }

  public async beginPairing(
    input: BeginPairingInput,
    signal?: AbortSignal,
  ): Promise<BeginPairingResult> {
    const body = await this.post(
      "/v1/pairings",
      { host_name: input.hostName, host_public_key: hex(input.hostPublicKey) },
      signal,
    );
    return {
      pairingId: requiredStringField(body, "pairing_id"),
      challenge: requiredHexField(body, "challenge", 32),
      watchSecret: requiredStringField(body, "watch_secret"),
      expiresAtMs: requiredIntegerField(body, "expires_at_ms"),
      serviceIdentifier: requiredStringField(body, "service_identifier"),
    };
  }

  public async watchPairing(
    pairingId: string,
    watchSecret: string,
    signal?: AbortSignal,
  ): Promise<WatchPairingResult> {
    const url = new URL(`/v1/pairings/${encodeURIComponent(pairingId)}/watch`, this.origin);
    url.searchParams.set("watch_secret", watchSecret);
    const body = await this.get(url, signal);
    const mobilePublicKey = optionalHexField(body, "mobile_public_key", 32);
    const routeId = optionalStringField(body, "route_id");
    return {
      pairingId: requiredStringField(body, "pairing_id"),
      state: requiredStringField(body, "state"),
      hostName: requiredStringField(body, "host_name"),
      ...(mobilePublicKey === undefined ? {} : { mobilePublicKey }),
      ...(routeId === undefined ? {} : { routeId }),
      hostConfirmed: requiredBooleanField(body, "host_confirmed"),
      mobileConfirmed: requiredBooleanField(body, "mobile_confirmed"),
      expiresAtMs: requiredIntegerField(body, "expires_at_ms"),
    };
  }

  public async completePairingAsHost(
    pairingId: string,
    watchSecret: string,
    signal?: AbortSignal,
  ): Promise<CompletePairingHostResult> {
    const body = await this.post(
      `/v1/pairings/${encodeURIComponent(pairingId)}/complete`,
      { actor: "host", watch_secret: watchSecret },
      signal,
    );
    const recipientDeviceId = optionalStringField(body, "recipient_device_id");
    return {
      hostId: requiredStringField(body, "host_id"),
      routeId: requiredStringField(body, "route_id"),
      deviceCredential: requiredStringField(body, "device_credential"),
      state: requiredStringField(body, "state"),
      ...(recipientDeviceId === undefined ? {} : { recipientDeviceId }),
    };
  }

  // POST /v1/relay-tickets (services/control-api/src/control.ts
  // issueRelayTicket): authenticates with the Host's own device credential
  // (`Authorization: Bearer <device_credential>`), not the pairing
  // watch_secret used above. Ticket lifetime is 10 minutes
  // (TICKET_LIFETIME_SECONDS in control.ts); callers needing a durable
  // supply of valid tickets should go through RelayTicketCache
  // (./relay-ticket-cache.ts) rather than calling this directly on every
  // relay operation.
  public async issueRelayTicket(
    input: IssueRelayTicketInput,
    signal?: AbortSignal,
  ): Promise<IssueRelayTicketResult> {
    const body = await this.post(
      "/v1/relay-tickets",
      { device_id: input.deviceId, route_ids: [...(input.routeIds ?? [])] },
      signal,
      { authorization: `Bearer ${input.deviceCredential}` },
    );
    return {
      ticket: requiredStringField(body, "ticket"),
      relayOrigin: requiredStringField(body, "relay_origin"),
      expiresAtMs: requiredIntegerField(body, "expires_at_ms"),
      routeEpoch: requiredBigintStringField(body, "route_epoch"),
    };
  }

  // POST /v1/routes/:routeId/recipient-device-id (services/control-api/src/
  // control.ts getRouteRecipientDevice): recovery/backfill path for a route
  // whose recipient_device_id was not captured from completePairingAsHost's
  // response (e.g. a pairing that predates that field). Authenticates the
  // same way issueRelayTicket does -- the device's own bearer credential --
  // and only ever returns the *other* device on `input.routeId`, never an
  // unrelated device or route.
  public async getRouteRecipientDevice(
    input: GetRouteRecipientDeviceInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const body = await this.post(
      `/v1/routes/${encodeURIComponent(input.routeId)}/recipient-device-id`,
      { device_id: input.deviceId },
      signal,
      { authorization: `Bearer ${input.deviceCredential}` },
    );
    return requiredStringField(body, "recipient_device_id");
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    headers?: Readonly<Record<string, string>>,
  ): Promise<Record<string, unknown>> {
    return this.send(new URL(path, this.origin), {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  private async get(url: URL, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.send(url, { method: "GET", ...(signal === undefined ? {} : { signal }) });
  }

  private async send(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ControlClientError("ABORTED", "Control request was aborted", { cause: error });
      }
      throw new ControlClientError("NETWORK", `Control request to ${url.pathname} failed`, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ControlClientError(
        "HTTP_STATUS",
        `Control request to ${url.pathname} failed (${response.status})`,
        { status: response.status },
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new ControlClientError("INVALID_RESPONSE", "Control response is not valid JSON", {
        cause: error,
      });
    }
    return requireRecord(json, "Control response");
  }
}

export class ControlClientError extends Error {
  /** The response's HTTP status, when code is "HTTP_STATUS" -- lets callers such as pairing.ts's waitForClaim retry a transient 5xx without retrying a definitive 4xx. */
  public readonly status: number | undefined;

  public constructor(
    public readonly code: "NETWORK" | "HTTP_STATUS" | "INVALID_RESPONSE" | "ABORTED",
    message: string,
    options?: ErrorOptions & { readonly status?: number },
  ) {
    super(message, options);
    this.name = "ControlClientError";
    this.status = options?.status;
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecordValue(value)) {
    throw new ControlClientError("INVALID_RESPONSE", `${label} must be a JSON object`);
  }
  return value;
}

function requiredStringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ControlClientError("INVALID_RESPONSE", `${name} is missing or invalid`);
  }
  return value;
}

function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredBooleanField(body: Record<string, unknown>, name: string): boolean {
  const value = body[name];
  if (typeof value !== "boolean") {
    throw new ControlClientError("INVALID_RESPONSE", `${name} is missing or invalid`);
  }
  return value;
}

function requiredIntegerField(body: Record<string, unknown>, name: string): bigint {
  const value = body[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ControlClientError("INVALID_RESPONSE", `${name} is missing or invalid`);
  }
  return BigInt(value);
}

// route_epoch is serialized as a decimal string (see
// services/control-api/src/control.ts: `route_epoch: selected.routeEpoch.toString()`),
// unlike expires_at_ms which is a JSON number -- bigints do not round-trip
// through JSON otherwise.
function requiredBigintStringField(body: Record<string, unknown>, name: string): bigint {
  const value = body[name];
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ControlClientError("INVALID_RESPONSE", `${name} is missing or invalid`);
  }
  return BigInt(value);
}

function requiredHexField(
  body: Record<string, unknown>,
  name: string,
  byteLength: number,
): Uint8Array {
  return decodeHexField(requiredStringField(body, name), name, byteLength);
}

function optionalHexField(
  body: Record<string, unknown>,
  name: string,
  byteLength: number,
): Uint8Array | undefined {
  const value = body[name];
  return typeof value === "string" && value.length > 0
    ? decodeHexField(value, name, byteLength)
    : undefined;
}

function decodeHexField(value: string, name: string, byteLength: number): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${byteLength * 2}}$`).test(value)) {
    throw new ControlClientError("INVALID_RESPONSE", `${name} must be ${byteLength}-byte hex`);
  }
  return fromHex(value);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

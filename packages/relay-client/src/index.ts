import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  type AckRequest,
  type AckResponse,
  type GetSnapshotRequest,
  type GetSnapshotResponse,
  type PublishRequest,
  type PublishResponse,
  type PutSnapshotRequest,
  type PutSnapshotResponse,
  type RelayFrame,
  RelayService,
  type SubscribeRequest,
} from "@pocket-omp/proto/relay/v1";

export interface RelayClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly interceptors?: readonly Interceptor[];
}

export class ConnectRelayClient {
  readonly #client: Client<typeof RelayService>;

  public constructor(options: RelayClientOptions) {
    const origin = URL.parse(options.baseUrl);
    if (origin === null || origin.protocol !== "https:") {
      throw new RelayClientError("INVALID_ORIGIN", "Relay origin must use HTTPS");
    }
    this.#client = createClient(
      RelayService,
      createConnectTransport({
        baseUrl: origin.origin,
        useBinaryFormat: true,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.interceptors === undefined ? {} : { interceptors: [...options.interceptors] }),
      }),
    );
  }

  public subscribe(request: SubscribeRequest, signal: AbortSignal): AsyncIterable<RelayFrame> {
    return this.#client.subscribe(request, { signal });
  }

  public publish(request: PublishRequest, signal?: AbortSignal): Promise<PublishResponse> {
    return this.#client.publish(request, signal === undefined ? undefined : { signal });
  }

  public acknowledge(request: AckRequest, signal?: AbortSignal): Promise<AckResponse> {
    return this.#client.ack(request, signal === undefined ? undefined : { signal });
  }

  public putSnapshot(
    request: PutSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<PutSnapshotResponse> {
    return this.#client.putSnapshot(request, signal === undefined ? undefined : { signal });
  }

  public getSnapshot(
    request: GetSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<GetSnapshotResponse> {
    return this.#client.getSnapshot(request, signal === undefined ? undefined : { signal });
  }
}

export interface ReconnectPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly random: () => number;
}

export function reconnectDelay(attempt: number, policy: ReconnectPolicy): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new RelayClientError("INVALID_ATTEMPT", "Reconnect attempt must be non-negative");
  }
  const random = policy.random();
  if (
    policy.baseDelayMs <= 0 ||
    policy.maxDelayMs < policy.baseDelayMs ||
    !Number.isFinite(random)
  ) {
    throw new RelayClientError("INVALID_POLICY", "Reconnect policy is invalid");
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt, 20));
  const jitter = Math.max(0, Math.min(1, random));
  return Math.floor(exponential * (0.5 + jitter * 0.5));
}

export class RelayClientError extends Error {
  public constructor(
    public readonly code: "INVALID_ORIGIN" | "INVALID_ATTEMPT" | "INVALID_POLICY",
    message: string,
  ) {
    super(message);
    this.name = "RelayClientError";
  }
}

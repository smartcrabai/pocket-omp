import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import {
  AckRequestSchema,
  type AckRequest,
  AckResponseSchema,
  type AckResponse,
  GetSnapshotRequestSchema,
  type GetSnapshotRequest,
  GetSnapshotResponseSchema,
  type GetSnapshotResponse,
  PublishRequestSchema,
  type PublishRequest,
  PublishResponseSchema,
  type PublishResponse,
  PutSnapshotRequestSchema,
  type PutSnapshotRequest,
  PutSnapshotResponseSchema,
  type PutSnapshotResponse,
  RelayFrameSchema,
  type RelayFrame,
  type SubscribeRequest,
} from "@pocket-omp/proto/relay/v1";

// A narrowed subset of the global `WebSocket` instance surface -- narrowed
// (mirroring apps/mobile/src/relay-port.ts's `RelaySocket`) so tests can
// inject a lightweight fake without implementing the full WebSocket
// interface (ping/pong/terminate/onopen.../a WebSocketEventMap-typed
// addEventListener, etc). The real, built-in WebSocket satisfies this
// structurally, so the default (`options.webSocket ?? WebSocket`) is
// unaffected.
export interface RelaySocketEvent {
  readonly data: unknown;
}

export interface RelaySocket {
  binaryType: string;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  addEventListener(
    type: "message",
    listener: (event: RelaySocketEvent) => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "open" | "error", listener: () => void): void;
}

export type RelaySocketConstructor = new (url: string, protocols: string[]) => RelaySocket;

// A narrowed subset of the global `fetch`'s call signature -- narrowed for
// the same reason as `RelaySocket` above: `typeof globalThis.fetch` also
// demands the static `fetch.preconnect` member the real global function
// carries, which a plain test fake has no reason to implement. The real
// global `fetch` still satisfies this structurally, so the default
// (`options.fetch ?? globalThis.fetch`) is unaffected.
export type RelayFetch = (
  input: string | URL,
  init?: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

export interface RelayClientOptions {
  readonly baseUrl: string;
  readonly fetch?: RelayFetch;
  readonly webSocket?: RelaySocketConstructor;
  readonly ticket?: string | (() => string | Promise<string>);
}

export class WorkerRelayClient {
  readonly #baseUrl: URL;
  readonly #fetch: RelayFetch;
  readonly #webSocket: RelaySocketConstructor;
  readonly #ticket: string | (() => string | Promise<string>) | undefined;

  public constructor(options: RelayClientOptions) {
    const origin = URL.parse(options.baseUrl);
    if (origin === null || origin.protocol !== "https:")
      throw new RelayClientError("INVALID_ORIGIN", "Relay origin must use HTTPS");
    this.#baseUrl = origin;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#webSocket = options.webSocket ?? WebSocket;
    this.#ticket = options.ticket;
  }

  public async *subscribe(
    request: SubscribeRequest,
    signal: AbortSignal,
  ): AsyncIterable<RelayFrame> {
    const url = new URL("/v1/relay/subscribe", this.#baseUrl);
    url.protocol = "wss:";
    url.searchParams.set("recipient_device_id", request.recipientDeviceId);
    url.searchParams.set("after", request.afterServerSequence.toString());
    url.searchParams.set("generation", request.connectionGeneration);
    const ticket = await this.#resolveTicket();
    const protocols =
      ticket === undefined
        ? ["pocket-omp-relay"]
        : ["pocket-omp-relay", `pocket-omp-ticket.${ticket}`];
    const socket = new this.#webSocket(url.toString(), protocols);
    socket.binaryType = "arraybuffer";

    const frames: RelayFrame[] = [];
    let wake: (() => void) | undefined;
    let failure: Error | undefined;
    let closed = false;
    let decodeChain = Promise.resolve();
    const notify = (): void => {
      const pending = wake;
      wake = undefined;
      pending?.();
    };
    socket.addEventListener("message", (event): void => {
      decodeChain = decodeChain
        .then(async () => {
          frames.push(fromBinary(RelayFrameSchema, await messageBytes(event.data)));
          notify();
          return undefined;
        })
        .catch((error: unknown) => {
          failure = new RelayClientError("MALFORMED_FRAME", errorMessage(error));
          socket.close(1002, "Malformed relay frame");
          notify();
        });
    });
    socket.addEventListener("error", (): void => {
      failure ??= new RelayClientError("CONNECTION_FAILED", "Relay WebSocket failed");
      notify();
    });
    socket.addEventListener("close", (): void => {
      closed = true;
      notify();
    });
    const abort = (): void => {
      socket.close(1000, "Subscription aborted");
      notify();
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      if (socket.readyState === WebSocket.CONNECTING)
        await new Promise<void>((resolve, reject) => {
          const opened = (): void => {
            socket.removeEventListener("error", failed);
            resolve();
          };
          const failed = (): void => {
            socket.removeEventListener("open", opened);
            reject(failure ?? new RelayClientError("CONNECTION_FAILED", "Relay WebSocket failed"));
          };
          socket.addEventListener("open", opened, { once: true });
          socket.addEventListener("error", failed, { once: true });
        });
      /* oxlint-disable eslint/no-await-in-loop -- Subscription waits for the next pushed frame before resuming iteration. */
      while (!signal.aborted) {
        const frame = frames.shift();
        if (frame !== undefined) {
          yield frame;
          continue;
        }
        if (failure !== undefined) throw failure;
        if (closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      /* oxlint-enable eslint/no-await-in-loop */
    } finally {
      signal.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close(1000, "Subscription closed");
    }
  }

  public publish(request: PublishRequest, signal?: AbortSignal): Promise<PublishResponse> {
    return this.#call(
      "/v1/relay/publish",
      "POST",
      PublishRequestSchema,
      request,
      PublishResponseSchema,
      signal,
    );
  }

  public acknowledge(request: AckRequest, signal?: AbortSignal): Promise<AckResponse> {
    return this.#call(
      "/v1/relay/ack",
      "POST",
      AckRequestSchema,
      request,
      AckResponseSchema,
      signal,
    );
  }

  public putSnapshot(
    request: PutSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<PutSnapshotResponse> {
    return this.#call(
      "/v1/relay/snapshot",
      "PUT",
      PutSnapshotRequestSchema,
      request,
      PutSnapshotResponseSchema,
      signal,
    );
  }

  public getSnapshot(
    request: GetSnapshotRequest,
    signal?: AbortSignal,
  ): Promise<GetSnapshotResponse> {
    return this.#call(
      "/v1/relay/snapshot",
      "POST",
      GetSnapshotRequestSchema,
      request,
      GetSnapshotResponseSchema,
      signal,
    );
  }

  async #call<Input extends DescMessage, Output extends DescMessage>(
    path: string,
    method: "POST" | "PUT",
    inputSchema: Input,
    input: MessageShape<Input>,
    outputSchema: Output,
    signal?: AbortSignal,
  ): Promise<MessageShape<Output>> {
    const ticket = await this.#resolveTicket();
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method,
      headers: {
        "content-type": "application/protobuf",
        accept: "application/protobuf",
        ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
      },
      body: toBinary(inputSchema, input),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new RelayClientError("REQUEST_FAILED", `${response.status}: ${detail}`);
    }
    return fromBinary(outputSchema, new Uint8Array(await response.arrayBuffer()));
  }

  async #resolveTicket(): Promise<string | undefined> {
    if (typeof this.#ticket === "function") return this.#ticket();
    return this.#ticket;
  }
}

export interface ReconnectPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly random: () => number;
}

export function reconnectDelay(attempt: number, policy: ReconnectPolicy): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0)
    throw new RelayClientError("INVALID_ATTEMPT", "Reconnect attempt must be non-negative");
  const random = policy.random();
  if (
    !Number.isFinite(policy.baseDelayMs) ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.baseDelayMs <= 0 ||
    policy.maxDelayMs < policy.baseDelayMs ||
    !Number.isFinite(random)
  )
    throw new RelayClientError("INVALID_POLICY", "Reconnect policy is invalid");
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(attempt, 20));
  const jitter = Math.max(0, Math.min(1, random));
  return Math.floor(exponential * (0.5 + jitter * 0.5));
}

export class RelayClientError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayClientError";
  }
}

async function messageBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new RelayClientError("MALFORMED_FRAME", "Relay WebSocket returned a non-binary frame");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// MobileRelayPort implementation (packages/mobile-core).
//
// Modeled on packages/relay-client/src/index.ts's WorkerRelayClient (the
// Worker-side reference), adapted for Mobile:
//   - issueTicket()/subscribe()/acknowledge() are driven by
//     MobileStreamManager.run() in exactly that order (see
//     packages/mobile-core/src/index.ts), so this class caches the
//     relayOrigin/generation/deviceId resolved by issueTicket() for the
//     subsequent subscribe()/acknowledge() calls.
//   - subscribe() implements the ADR-014 initial-sync + reset-recovery path:
//     a cursor of 0n (never synced before) triggers an up-front snapshot
//     fetch to resolve a real starting cursor before opening the
//     WebSocket; a `ResetRequired` frame received mid-stream (a genuine
//     retention-gap reset, per ADR-014 -- "only a retention gap resets
//     state from an encrypted snapshot") triggers the same snapshot fetch
//     and a transparent reconnect, so MobileStreamManager.run() keeps
//     running instead of throwing. The frame's own `generation` is always
//     the stable value returned by issueTicket() (this port's own
//     connection-attempt id), which is preserved across such a reconnect,
//     so MobileStreamManager's "generation changed without snapshot reset"
//     invariant check never fires for a reset this port already handled.
//   - fetch/WebSocket/now/controlUrl are all injected (constructor deps),
//     matching relay-ticket.ts's existing pattern, so this module never
//     touches a global and stays fully testable under `bun test`.
//
// Deliberately out of scope (left to a future task, most likely #8 "Connect
// MobileStreamManager to session UI"): reconstructing the projection body
// from a fetched snapshot's ciphertext. This port only extracts the
// snapshot's `coversThroughSequence` to resume the delta stream past a gap;
// see projection-store.ts's doc comment for the matching cursor-only
// persistence decision.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { MobileRelayFrame, MobileRelayPort } from "@pocket-omp/mobile-core";
import {
  AckRequestSchema,
  AckResponseSchema,
  GetSnapshotRequestSchema,
  GetSnapshotResponseSchema,
  RelayFrameSchema,
} from "@pocket-omp/proto/relay/v1";
import { RelayTicketClient, type DeviceCredentialInput } from "./relay-ticket";

// Standard WebSocket readyState values (avoids depending on the global
// `WebSocket` class purely for its static constants).
const WS_CONNECTING = 0;
const WS_OPEN = 1;

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const RESET_RECONNECT_BASE_DELAY_MS = 200;
const RESET_RECONNECT_MAX_DELAY_MS = 10_000;

export interface RelaySocketEvent {
  readonly data: unknown;
}

// A narrowed subset of the global `WebSocket` instance surface -- narrowed
// for the same reason relay-ticket.ts narrows `fetch`: tests can inject a
// lightweight fake without implementing the full DOM WebSocket interface.
// The real, built-in WebSocket satisfies this structurally.
export interface RelaySocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
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
  removeEventListener(type: "open" | "close" | "error", listener: () => void): void;
}

export type RelaySocketConstructor = new (url: string, protocols: readonly string[]) => RelaySocket;

export interface RelayResetInfo {
  readonly reason: string;
  readonly latestSnapshotId: string;
  readonly earliestAvailableSequence: bigint;
}

// A narrowed subset of the global `fetch`'s call signature, covering both
// this port's own protobuf POSTs (which need `arrayBuffer()`) and
// relay-ticket.ts's narrower JSON-only `RelayTicketFetch` (this type is
// structurally assignable to it). Deliberately not `typeof globalThis.fetch`
// itself: that type also demands the static `fetch.preconnect` member the
// real global function carries, which a plain test fake has no reason to
// implement -- the same narrowing rationale as relay-ticket.ts's own
// `RelayTicketFetch`.
export interface RelayFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type RelayFetch = (
  input: string | URL,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | Uint8Array;
  },
) => Promise<RelayFetchResponse>;

export interface MobileRelayPortDeps {
  readonly fetch: RelayFetch;
  readonly webSocket: RelaySocketConstructor;
  readonly now: () => number;
  readonly controlUrl: string;
  readonly credential: DeviceCredentialInput;
  readonly routeIds?: readonly string[];
  // Fired whenever a ResetRequired frame is handled (see the module doc
  // comment); purely for observability -- e.g. a future UI layer clearing
  // its own cache -- since this port already resumes the stream on its own.
  readonly onResetRequired?: (info: RelayResetInfo) => void;
  /** How long to wait for the WebSocket handshake to complete before giving up (default 15s). Overridable so tests can exercise the timeout without a real wait. */
  readonly connectTimeoutMs?: number;
}

export class RelayConnectionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RelayConnectionError";
  }
}

export class MobileWebSocketRelayPort implements MobileRelayPort {
  readonly #deps: MobileRelayPortDeps;
  readonly #ticketClient: RelayTicketClient;
  #relayOrigin: string | undefined;
  #ticket: string | undefined;
  #generation: string | undefined;

  public constructor(deps: MobileRelayPortDeps) {
    this.#deps = deps;
    this.#ticketClient = new RelayTicketClient({
      fetch: deps.fetch,
      now: deps.now,
      controlUrl: deps.controlUrl,
    });
  }

  public async issueTicket(): Promise<{ readonly ticket: string; readonly generation: string }> {
    const ticket = await this.#ticketClient.getTicket(this.#deps.credential, this.#deps.routeIds);
    this.#relayOrigin = ticket.relayOrigin;
    this.#ticket = ticket.ticket;
    this.#generation = crypto.randomUUID();
    return { ticket: ticket.ticket, generation: this.#generation };
  }

  public async *subscribe(input: {
    readonly ticket: string;
    readonly afterServerSequence: bigint;
    readonly signal: AbortSignal;
  }): AsyncGenerator<MobileRelayFrame> {
    const relayOrigin = this.#relayOrigin;
    const generation = this.#generation;
    if (relayOrigin === undefined || generation === undefined)
      throw new RelayConnectionError("subscribe() was called before issueTicket()");
    let after = input.afterServerSequence;
    if (after === 0n) {
      after = await this.#fetchSnapshotCursor(relayOrigin, input.ticket).catch(() => 0n);
    }
    // Counts resets received back-to-back with no frame successfully
    // streamed in between; reset to 0 the moment any frame gets through (see
    // below). A single, ordinary retention-gap reset (ADR-014) always finds
    // this at 0 and reconnects immediately -- backoff only kicks in once the
    // relay keeps resetting the connection before any progress is made.
    let consecutiveResets = 0;
    /* oxlint-disable eslint/no-await-in-loop -- each connection attempt (and any reset recovery) must settle before the next one starts; there is nothing to parallelize. */
    while (!input.signal.aborted) {
      const url = new URL("/v1/relay/subscribe", relayOrigin);
      url.protocol = "wss:";
      url.searchParams.set("recipient_device_id", this.#deps.credential.deviceId);
      url.searchParams.set("after", after.toString());
      url.searchParams.set("generation", generation);
      const protocols = ["pocket-omp-relay", `pocket-omp-ticket.${input.ticket}`];
      const session = this.#runSession(url, protocols, generation, input.signal);
      let step = await session.next();
      while (step.done !== true) {
        consecutiveResets = 0;
        after = step.value.serverSequence;
        yield step.value;
        step = await session.next();
      }
      if (input.signal.aborted) return;
      const reset = step.value;
      if (reset === undefined) return;
      this.#deps.onResetRequired?.(reset);
      consecutiveResets += 1;
      await delayBeforeResetReconnect(consecutiveResets, input.signal);
      const snapshotId = reset.latestSnapshotId.length > 0 ? reset.latestSnapshotId : undefined;
      after = await this.#fetchSnapshotCursor(relayOrigin, input.ticket, snapshotId).catch(
        () => reset.earliestAvailableSequence,
      );
    }
    /* oxlint-enable eslint/no-await-in-loop */
  }

  public async acknowledge(serverSequence: bigint): Promise<void> {
    const relayOrigin = this.#relayOrigin;
    const ticket = this.#ticket;
    if (relayOrigin === undefined || ticket === undefined)
      throw new RelayConnectionError("acknowledge() was called before issueTicket()");
    const response = await this.#deps.fetch(new URL("/v1/relay/ack", relayOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/protobuf",
        accept: "application/protobuf",
        authorization: `Bearer ${ticket}`,
      },
      body: toBinary(
        AckRequestSchema,
        create(AckRequestSchema, {
          recipientDeviceId: this.#deps.credential.deviceId,
          serverSequence,
        }),
      ),
    });
    if (!response.ok)
      throw new RelayConnectionError(`Relay acknowledge failed with status ${response.status}`);
    const decoded = fromBinary(AckResponseSchema, new Uint8Array(await response.arrayBuffer()));
    if (decoded.acceptedServerSequence !== serverSequence)
      throw new RelayConnectionError("Relay acknowledged an unexpected server sequence");
  }

  async #fetchSnapshotCursor(
    relayOrigin: string,
    ticket: string,
    snapshotId?: string,
  ): Promise<bigint> {
    const response = await this.#deps.fetch(new URL("/v1/relay/snapshot", relayOrigin), {
      method: "POST",
      headers: {
        "content-type": "application/protobuf",
        accept: "application/protobuf",
        authorization: `Bearer ${ticket}`,
      },
      body: toBinary(
        GetSnapshotRequestSchema,
        create(GetSnapshotRequestSchema, {
          recipientDeviceId: this.#deps.credential.deviceId,
          ...(snapshotId === undefined ? {} : { snapshotId }),
        }),
      ),
    });
    if (!response.ok)
      throw new RelayConnectionError(`Relay snapshot fetch failed with status ${response.status}`);
    const decoded = fromBinary(
      GetSnapshotResponseSchema,
      new Uint8Array(await response.arrayBuffer()),
    );
    if (decoded.snapshot === undefined)
      throw new RelayConnectionError("No relay snapshot is available yet");
    return decoded.snapshot.coversThroughSequence;
  }

  // Drives a single WebSocket connection, yielding envelope frames as they
  // arrive and returning either a RelayResetInfo (the socket was closed
  // because the server sent ResetRequired -- see subscribe()'s reconnect
  // loop) or undefined (the socket closed/aborted with nothing further to
  // do).
  async *#runSession(
    url: URL,
    protocols: readonly string[],
    generation: string,
    signal: AbortSignal,
  ): AsyncGenerator<MobileRelayFrame, RelayResetInfo | undefined> {
    const socket = new this.#deps.webSocket(url.toString(), protocols);
    socket.binaryType = "arraybuffer";

    const queue: MobileRelayFrame[] = [];
    let resetInfo: RelayResetInfo | undefined;
    let failure: Error | undefined;
    let closed = false;
    let wake: (() => void) | undefined;
    let decodeChain = Promise.resolve();

    const notify = (): void => {
      const pending = wake;
      wake = undefined;
      pending?.();
    };

    socket.addEventListener("message", (event: RelaySocketEvent): void => {
      decodeChain = decodeChain
        .then(async () => {
          const bytes = await messageBytes(event.data);
          const frame = fromBinary(RelayFrameSchema, bytes);
          switch (frame.body.case) {
            case "envelope": {
              const envelope = frame.body.value.envelope;
              if (envelope === undefined)
                throw new RelayConnectionError("Relay frame is missing its sealed envelope");
              queue.push({
                serverSequence: frame.body.value.serverSequence,
                generation,
                eventId: envelope.messageId,
                encrypted: envelope,
              });
              break;
            }
            case "resetRequired":
              resetInfo = {
                reason: frame.body.value.reason,
                latestSnapshotId: frame.body.value.latestSnapshotId,
                earliestAvailableSequence: frame.body.value.earliestAvailableSequence,
              };
              socket.close(1000, "Reset required");
              break;
            case "heartbeat":
            case "reauthenticate":
            case "streamSuperseded":
              // Not currently emitted by services/control-api/src/relay.ts
              // (RelayMailbox never constructs these frames today); handled
              // as forward-compatible no-ops so a future server change
              // degrades gracefully instead of tearing down the stream.
              break;
            case undefined:
              throw new RelayConnectionError("Relay frame is missing a body");
          }
          return undefined;
        })
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          try {
            socket.close(1002, "Malformed relay frame");
          } catch {
            // Already closing/closed.
          }
        })
        .finally(() => {
          notify();
        });
    });
    socket.addEventListener("error", (): void => {
      failure ??= new RelayConnectionError("Relay WebSocket failed");
      notify();
    });
    socket.addEventListener("close", (): void => {
      closed = true;
      notify();
    });
    const abort = (): void => {
      try {
        socket.close(1000, "Subscription aborted");
      } catch {
        // Already closing/closed.
      }
      notify();
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      if (socket.readyState === WS_CONNECTING) {
        // Bounded by a timeout and by `signal`: neither "open" nor "error"
        // is guaranteed to fire for a handshake that stalls on a lossy
        // network or a middlebox that silently drops the connection, and
        // socket.close() during CONNECTING is not guaranteed to raise
        // "error" either -- without this, such a stall would hang the
        // subscription (and this port's caller's retry/backoff logic)
        // forever.
        await new Promise<void>((resolve, reject) => {
          const cleanup = (): void => {
            socket.removeEventListener("open", opened);
            socket.removeEventListener("error", failed);
            signal.removeEventListener("abort", onAbort);
            clearTimeout(timer);
          };
          const opened = (): void => {
            cleanup();
            resolve();
          };
          const failed = (): void => {
            cleanup();
            reject(failure ?? new RelayConnectionError("Relay WebSocket failed"));
          };
          const onAbort = (): void => {
            // Matches the frame-wait loop below, which treats an abort as a
            // clean stop (loop condition false, generator returns) rather
            // than a failure -- resolving here lets execution fall through
            // to that same loop, which immediately exits the same way.
            cleanup();
            resolve();
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(new RelayConnectionError("Timed out waiting for the relay WebSocket to open"));
          }, this.#deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
          socket.addEventListener("open", opened, { once: true });
          socket.addEventListener("error", failed, { once: true });
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      /* oxlint-disable eslint/no-await-in-loop -- waits for the next pushed frame or terminal event before resuming iteration. */
      while (!signal.aborted) {
        const frame = queue.shift();
        if (frame !== undefined) {
          yield frame;
          continue;
        }
        if (failure !== undefined) throw failure;
        if (resetInfo !== undefined || closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      /* oxlint-enable eslint/no-await-in-loop */
    } finally {
      signal.removeEventListener("abort", abort);
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING)
        socket.close(1000, "Subscription closed");
    }
    return resetInfo;
  }
}

// Capped exponential backoff, applied only from the second consecutive reset
// onward (see subscribe()'s doc comment). Resolves early if aborted --
// mirrors pairing.ts's delay() shape (one resolve site, one reject site) and
// swallows the abort rejection so it never delays shutdown or surfaces as a
// subscribe() failure; the caller's own `while (!signal.aborted)` already
// handles exiting gracefully on the very next loop check.
function delayBeforeResetReconnect(consecutiveResets: number, signal: AbortSignal): Promise<void> {
  if (consecutiveResets <= 1 || signal.aborted) return Promise.resolve();
  const delayMs = Math.min(
    RESET_RECONNECT_BASE_DELAY_MS * 2 ** (consecutiveResets - 2),
    RESET_RECONNECT_MAX_DELAY_MS,
  );
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new RelayConnectionError("Reset-reconnect backoff aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  }).catch(() => undefined);
}

async function messageBytes(value: unknown): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new RelayConnectionError("Relay WebSocket returned a non-binary frame");
}

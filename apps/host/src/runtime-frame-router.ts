// HostDaemon's single reader over a Runtime connection's frame stream
// (packages/agent-runtime-client's RuntimeProcessClient.events()).
//
// An AsyncIterator only ever has one legitimate consumer, but Agent Runtime
// produces two independent categories of frames on that one stream:
//   - request/response frames Host itself triggers sequentially (hello,
//     ready, commandAccepted/commandResult, snapshot, heartbeat) and awaits
//     one at a time (see host-daemon.ts's startRuntime/abortRuntime/
//     shutdownRuntime).
//   - `event` frames Runtime sends autonomously and continuously
//     (apps/host/src/runtime-server.ts's #forwardEvents), independent of
//     whatever request/response exchange Host may or may not currently be
//     waiting on.
//
// Before this module existed, Host only ever called frames.next() while a
// request/response wait was in flight, so `event` frames sent in between
// just sat unconsumed until the next explicit wait happened to drain them
// (apps/host's task description documents this as the bug being fixed).
//
// RuntimeFrameRouter is the fix: the ONE reader of the stream. A single loop
// (#run) continuously reads every frame and routes it by payload.case.
// `event` frames go straight to `onEvent`, as soon as they arrive.
// Everything else is delivered to whichever `waitFor()` call is currently
// registered -- there is at most one at a time, matching how host-daemon.ts
// always awaits one request's response before issuing the next.
//
// fault/stream-end handling mirrors the pre-multiplexing implementation's
// nextMatchingFrame:
//   - A `fault` frame immediately rejects whoever is currently waiting. If
//     nobody is waiting, it is held and delivered -- once -- to the very
//     next waitFor() call, exactly like the single-iterator version would
//     pick up a buffered fault frame on its next explicit read.
//   - Stream end is permanent: once observed, every current and future
//     waitFor() call rejects immediately (rather than waiting out a
//     pointless timeout), since the stream will never produce another
//     frame.
//   - A non-event/non-fault frame that arrives while nobody is registered is
//     buffered (matching #pendingFault's approach) rather than dropped. This
//     is not just a stray-frame edge case: host-daemon.ts's abortRuntime
//     awaits commandAccepted then commandResult back to back with no I/O in
//     between, so both can already be sitting in the underlying stream by
//     the time the first waitFor() resolves -- without buffering, #run()'s
//     pump can deliver the second frame before abortRuntime has re-registered
//     its second wait, permanently dropping it and causing a false TIMEOUT
//     even though Runtime already answered.
import type { RuntimeFrame } from "@pocket-omp/proto/runtime/v1";

export type RuntimeFrameCase = Exclude<RuntimeFrame["payload"]["case"], undefined>;

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

export interface RuntimeFrameRouterOptions {
  readonly frames: AsyncIterator<RuntimeFrame>;
  /** Called for every `event` frame, in arrival order, as soon as it is read. Must not reject in normal operation -- a throwing onEvent is caught and reported via onEventError so a bug there can never take down frame routing. */
  readonly onEvent: (frame: RuntimeFrame) => void | Promise<void>;
  readonly onEventError?: (error: unknown) => void;
}

interface PendingWaiter {
  readonly expectedCase: RuntimeFrameCase;
  readonly requestId: string | undefined;
  readonly resolve: (frame: RuntimeFrame) => void;
  readonly reject: (error: unknown) => void;
}

type FrameOutcome =
  | { readonly kind: "frame"; readonly result: IteratorResult<RuntimeFrame> }
  | { readonly kind: "stopped" };

export class RuntimeFrameRouter {
  readonly #options: RuntimeFrameRouterOptions;
  readonly #pump: Promise<void>;
  readonly #stopSignal = Promise.withResolvers<void>();
  #pending: PendingWaiter | undefined;
  #pendingFault: unknown;
  readonly #pendingFrames: RuntimeFrame[] = [];
  #terminal: unknown;
  #stopped = false;

  public constructor(options: RuntimeFrameRouterOptions) {
    this.#options = options;
    this.#pump = this.#run();
  }

  /**
   * Waits for the next frame matching expectedCase (and requestId, if
   * given), racing against timeoutMs. Mirrors the previous
   * nextMatchingFrame + nextFrame contract exactly: `fault` frames reject
   * immediately (never wait out the timeout), a timeout throws
   * RuntimeFrameRouterError("TIMEOUT", ...) and abandons the wait (a later
   * matching frame, if any, is buffered but -- since requestId is a fresh
   * UUID per call -- never claimed by a future wait), and any other
   * mismatched frame received while this wait is active is skipped rather
   * than resolving it.
   */
  public async waitFor(
    expectedCase: RuntimeFrameCase,
    requestId?: string,
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<RuntimeFrame> {
    const timeout = Promise.withResolvers<undefined>();
    const timer = setTimeout(timeout.resolve, timeoutMs);
    try {
      const result = await Promise.race([this.#register(expectedCase, requestId), timeout.promise]);
      if (result === undefined) {
        this.#pending = undefined;
        throw new RuntimeFrameRouterError(
          "TIMEOUT",
          `Timed out waiting for Runtime ${expectedCase}`,
        );
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stops the reader loop (idempotent) and waits for it to fully settle.
   * Never throws. Must be awaited before a RuntimeConnection is discarded
   * (close(), a failed startRuntime, or a Runtime restart's old generation)
   * so the background pump never outlives it.
   *
   * This resolves promptly even if the underlying frame source's next() call
   * is still blocked (e.g. Runtime never sent `hello` and its process is
   * still alive) -- #run() races every read against #stopSignal rather than
   * only checking #stopped between reads, so stop() is never at the mercy of
   * however long the underlying transport takes to actually end.
   */
  public async stop(): Promise<void> {
    this.#stopped = true;
    this.#stopSignal.resolve();
    await this.#pump;
  }

  #register(expectedCase: RuntimeFrameCase, requestId: string | undefined): Promise<RuntimeFrame> {
    if (this.#pending !== undefined) {
      throw new RuntimeFrameRouterError("BUSY", "Another waitFor() call is already pending");
    }
    if (this.#terminal !== undefined) return Promise.reject(this.#terminal);
    if (this.#pendingFault !== undefined) {
      const fault = this.#pendingFault;
      this.#pendingFault = undefined;
      return Promise.reject(fault);
    }
    const buffered = this.#takeBufferedFrame(expectedCase, requestId);
    if (buffered !== undefined) return Promise.resolve(buffered);
    const { promise, resolve, reject } = Promise.withResolvers<RuntimeFrame>();
    this.#pending = { expectedCase, requestId, resolve, reject };
    return promise;
  }

  #takeBufferedFrame(
    expectedCase: RuntimeFrameCase,
    requestId: string | undefined,
  ): RuntimeFrame | undefined {
    const index = this.#pendingFrames.findIndex(
      (frame) =>
        frame.payload.case === expectedCase &&
        (requestId === undefined || frame.requestId === requestId),
    );
    if (index === -1) return undefined;
    const [frame] = this.#pendingFrames.splice(index, 1);
    return frame;
  }

  async #run(): Promise<void> {
    for (;;) {
      if (this.#stopped) return;
      let outcome: FrameOutcome;
      try {
        // oxlint-disable-next-line no-await-in-loop -- Frames must be routed strictly in arrival order; racing against #stopSignal is what makes stop() non-blocking regardless of the underlying transport's state.
        outcome = await Promise.race([
          this.#options.frames.next().then((result): FrameOutcome => ({ kind: "frame", result })),
          this.#stopSignal.promise.then((): FrameOutcome => ({ kind: "stopped" })),
        ]);
      } catch (error) {
        this.#fail(error);
        return;
      }
      if (outcome.kind === "stopped" || this.#stopped) return;
      const result = outcome.result;
      if (result.done) {
        this.#fail(new RuntimeFrameRouterError("STREAM_ENDED", "Agent Runtime stream ended"));
        return;
      }
      const frame = result.value;
      if (frame.payload.case === "event") {
        try {
          // oxlint-disable-next-line no-await-in-loop -- Event handling must preserve arrival order relative to response frames.
          await this.#options.onEvent(frame);
        } catch (error) {
          this.#options.onEventError?.(error);
        }
        continue;
      }
      if (frame.payload.case === "fault") {
        this.#deliverFault(
          new RuntimeFrameRouterError(
            "FAULT",
            `${frame.payload.value.code}: ${frame.payload.value.message}`,
          ),
        );
        continue;
      }
      this.#deliver(frame);
    }
  }

  #deliver(frame: RuntimeFrame): void {
    const pending = this.#pending;
    if (pending === undefined) {
      // Nobody is registered yet -- this may be the imminent-registration
      // race described above, so hold onto it rather than dropping it.
      this.#pendingFrames.push(frame);
      return;
    }
    if (
      frame.payload.case !== pending.expectedCase ||
      (pending.requestId !== undefined && frame.requestId !== pending.requestId)
    ) {
      return; // Doesn't match the current wait; drop it.
    }
    this.#pending = undefined;
    pending.resolve(frame);
  }

  #deliverFault(error: unknown): void {
    const pending = this.#pending;
    if (pending === undefined) {
      this.#pendingFault = error;
      return;
    }
    this.#pending = undefined;
    pending.reject(error);
  }

  #fail(error: unknown): void {
    this.#terminal = error;
    const pending = this.#pending;
    if (pending !== undefined) {
      this.#pending = undefined;
      pending.reject(error);
    }
  }
}

export class RuntimeFrameRouterError extends Error {
  public constructor(
    public readonly code: "BUSY" | "STREAM_ENDED" | "FAULT" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeFrameRouterError";
  }
}

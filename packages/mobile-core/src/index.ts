export type StreamState =
  | { readonly kind: "idle" }
  | { readonly kind: "obtaining-ticket" }
  | { readonly kind: "connecting"; readonly generation: string }
  | { readonly kind: "catching-up"; readonly generation: string; readonly cursor: bigint }
  | { readonly kind: "live"; readonly generation: string; readonly cursor: bigint }
  | { readonly kind: "backing-off"; readonly attempt: number; readonly retryAtMs: bigint }
  | { readonly kind: "reauthenticating" }
  | { readonly kind: "suspended"; readonly cursor: bigint }
  | { readonly kind: "entitlement-required" }
  | { readonly kind: "fatal"; readonly code: string };

export type StreamAction =
  | { readonly kind: "foregrounded" }
  | { readonly kind: "ticket-obtained"; readonly generation: string }
  | { readonly kind: "connected"; readonly generation: string; readonly cursor: bigint }
  | { readonly kind: "caught-up"; readonly generation: string; readonly cursor: bigint }
  | { readonly kind: "frame-applied"; readonly generation: string; readonly cursor: bigint }
  | { readonly kind: "ticket-expiring" }
  | { readonly kind: "transient-failure"; readonly retryAtMs: bigint }
  | { readonly kind: "backgrounded"; readonly cursor: bigint }
  | { readonly kind: "entitlement-lost" }
  | { readonly kind: "fatal"; readonly code: string };

export function transitionStream(state: StreamState, action: StreamAction): StreamState {
  switch (action.kind) {
    case "foregrounded":
      if (state.kind === "idle" || state.kind === "suspended" || state.kind === "backing-off") {
        return { kind: "obtaining-ticket" };
      }
      break;
    case "ticket-obtained":
      if (state.kind === "obtaining-ticket" || state.kind === "reauthenticating") {
        return { kind: "connecting", generation: action.generation };
      }
      break;
    case "connected":
      if (state.kind === "connecting" && state.generation === action.generation) {
        return { kind: "catching-up", generation: action.generation, cursor: action.cursor };
      }
      break;
    case "caught-up":
      if (state.kind === "catching-up" && state.generation === action.generation) {
        return { kind: "live", generation: action.generation, cursor: action.cursor };
      }
      break;
    case "frame-applied":
      if (
        (state.kind === "catching-up" || state.kind === "live") &&
        state.generation === action.generation &&
        action.cursor > state.cursor
      ) {
        return { ...state, cursor: action.cursor };
      }
      if (
        (state.kind === "catching-up" || state.kind === "live") &&
        state.generation !== action.generation
      ) {
        return state;
      }
      break;
    case "ticket-expiring":
      if (state.kind === "connecting" || state.kind === "catching-up" || state.kind === "live") {
        return { kind: "reauthenticating" };
      }
      break;
    case "transient-failure": {
      const attempt = state.kind === "backing-off" ? state.attempt + 1 : 1;
      return { kind: "backing-off", attempt, retryAtMs: action.retryAtMs };
    }
    case "backgrounded":
      return { kind: "suspended", cursor: action.cursor };
    case "entitlement-lost":
      return { kind: "entitlement-required" };
    case "fatal":
      return { kind: "fatal", code: action.code };
  }
  throw new MobileInvariantError(`Invalid stream transition ${state.kind} -> ${action.kind}`);
}

export interface ProjectionEvent {
  readonly eventId: string;
  readonly revision: bigint;
  readonly sessionId?: string;
  readonly kind: string;
  readonly payload: unknown;
}

export interface ProjectionState {
  readonly appliedEventIds: ReadonlySet<string>;
  readonly revisionBySession: ReadonlyMap<string, bigint>;
  readonly events: readonly ProjectionEvent[];
}

export function applyProjectionEvent(
  state: ProjectionState,
  event: ProjectionEvent,
): { readonly state: ProjectionState; readonly applied: boolean } {
  if (state.appliedEventIds.has(event.eventId)) return { state, applied: false };
  if (event.sessionId !== undefined) {
    const previous = state.revisionBySession.get(event.sessionId) ?? 0n;
    if (event.revision <= previous) return { state, applied: false };
  }
  const appliedEventIds = new Set(state.appliedEventIds);
  appliedEventIds.add(event.eventId);
  const revisionBySession = new Map(state.revisionBySession);
  if (event.sessionId !== undefined) revisionBySession.set(event.sessionId, event.revision);
  return {
    applied: true,
    state: { appliedEventIds, revisionBySession, events: [...state.events, event] },
  };
}

export function emptyProjection(): ProjectionState {
  return { appliedEventIds: new Set(), revisionBySession: new Map(), events: [] };
}

export interface MobileRelayFrame {
  readonly serverSequence: bigint;
  readonly generation: string;
  readonly eventId: string;
  readonly encrypted: unknown;
}

export interface MobileRelayPort {
  issueTicket(): Promise<{ readonly ticket: string; readonly generation: string }>;
  subscribe(input: {
    readonly ticket: string;
    readonly afterServerSequence: bigint;
    readonly signal: AbortSignal;
  }): AsyncIterable<MobileRelayFrame>;
  acknowledge(serverSequence: bigint): Promise<void>;
}

export interface MobileProjectionStore {
  load(): Promise<{ readonly cursor: bigint; readonly projection: ProjectionState }>;
  commit(cursor: bigint, projection: ProjectionState): Promise<void>;
}

export interface MobileEnvelopeCrypto {
  open(frame: MobileRelayFrame): Promise<ProjectionEvent>;
}

export class MobileStreamManager {
  #state: StreamState = { kind: "idle" };

  public constructor(
    private readonly relay: MobileRelayPort,
    private readonly store: MobileProjectionStore,
    private readonly crypto: MobileEnvelopeCrypto,
    private readonly onState: (state: StreamState) => void = () => undefined,
    private readonly onFrameError: (error: unknown, frame: MobileRelayFrame) => void = () =>
      undefined,
  ) {}

  public get state(): StreamState {
    return this.#state;
  }

  public async run(signal: AbortSignal): Promise<void> {
    this.move({ kind: "foregrounded" });
    const ticket = await this.relay.issueTicket();
    this.move({ kind: "ticket-obtained", generation: ticket.generation });
    const loaded = await this.store.load();
    this.move({ kind: "connected", generation: ticket.generation, cursor: loaded.cursor });
    let projection = loaded.projection;
    let cursor = loaded.cursor;
    const stream = this.relay.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: cursor,
      signal,
    });
    this.move({ kind: "caught-up", generation: ticket.generation, cursor });
    for await (const frame of stream) {
      if (signal.aborted) break;
      if (frame.generation !== ticket.generation) {
        throw new MobileInvariantError("Relay generation changed without snapshot reset");
      }
      try {
        const event = await this.crypto.open(frame);
        projection = applyProjectionEvent(projection, event).state;
      } catch (error) {
        // A single envelope that fails to decrypt/decode (tampered,
        // corrupted, or sealed under a stale key) must not wedge the stream
        // forever: skip just this frame and keep advancing, rather than
        // leaving the cursor pinned on an unprocessable message that every
        // retry would refetch from the same position and fail on again
        // identically.
        this.onFrameError(error, frame);
      }
      cursor = frame.serverSequence;
      await this.store.commit(cursor, projection);
      await this.relay.acknowledge(cursor);
      this.move({ kind: "frame-applied", generation: ticket.generation, cursor });
    }
  }

  public suspend(cursor: bigint): void {
    this.move({ kind: "backgrounded", cursor });
  }

  private move(action: StreamAction): void {
    this.#state = transitionStream(this.#state, action);
    this.onState(this.#state);
  }
}

export class MobileInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MobileInvariantError";
  }
}

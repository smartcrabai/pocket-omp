// Pure mapping from MobileStreamManager's StreamState (packages/mobile-core)
// to what the UI should show. Kept framework-independent (no expo/
// react-native imports) so it is directly exercised by `bun test`.
import type { StreamState } from "@pocket-omp/mobile-core";

export type StreamTone =
  | "connecting"
  | "syncing"
  | "live"
  | "retrying"
  | "reauthenticating"
  | "suspended"
  | "entitlement-required"
  | "fatal";

export interface StreamDisplay {
  readonly tone: StreamTone;
  readonly label: string;
  readonly detail: string;
  readonly showSubscriptionCta: boolean;
}

// `runFailure`, when set, overrides the state-derived display with an error
// presentation. It exists because MobileStreamManager.run() (packages/
// mobile-core) can reject (e.g. an auth error from issueTicket(), a
// malformed-frame error from crypto.open()) without itself transitioning
// `state` to anything distinguishable -- `move()` is private, and run()'s
// body never calls it on the failure path, only re-throws. The composition
// root (stream.tsx) catches that rejection, forces the manager back to a
// resumable state via the one unconditional public transition
// (suspend()), and threads the failure message in here so the UI can tell
// "paused because backgrounded" apart from "paused because the connection
// broke".
// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed StreamState union; a new case fails to compile.
export function describeStreamState(state: StreamState, runFailure?: string): StreamDisplay {
  if (runFailure !== undefined) {
    return {
      tone: "fatal",
      label: "CONNECTION ERROR",
      detail: runFailure,
      showSubscriptionCta: false,
    };
  }
  switch (state.kind) {
    case "idle":
      return {
        tone: "connecting",
        label: "IDLE",
        detail: "Not yet connected to the Relay.",
        showSubscriptionCta: false,
      };
    case "obtaining-ticket":
      return {
        tone: "connecting",
        label: "CONNECTING",
        detail: "Requesting a Relay ticket.",
        showSubscriptionCta: false,
      };
    case "connecting":
      return {
        tone: "connecting",
        label: "CONNECTING",
        detail: "Opening the encrypted Relay channel.",
        showSubscriptionCta: false,
      };
    case "catching-up":
      return {
        tone: "syncing",
        label: "SYNCING",
        detail: "Catching up on events you missed.",
        showSubscriptionCta: false,
      };
    case "live":
      return {
        tone: "live",
        label: "LIVE",
        detail: "Streaming session updates in real time.",
        showSubscriptionCta: false,
      };
    case "backing-off":
      return {
        tone: "retrying",
        label: "RETRYING",
        detail: `Reconnecting (attempt ${state.attempt}).`,
        showSubscriptionCta: false,
      };
    case "reauthenticating":
      return {
        tone: "reauthenticating",
        label: "REAUTHENTICATING",
        detail: "Refreshing your Relay ticket.",
        showSubscriptionCta: false,
      };
    case "suspended":
      return {
        tone: "suspended",
        label: "PAUSED",
        detail: "Paused while Pocket OMP is in the background.",
        showSubscriptionCta: false,
      };
    case "entitlement-required":
      return {
        tone: "entitlement-required",
        label: "SUBSCRIPTION REQUIRED",
        detail: "Relay Pro is required to keep streaming sessions.",
        showSubscriptionCta: true,
      };
    case "fatal":
      return {
        tone: "fatal",
        label: "CONNECTION ERROR",
        detail: `The Relay connection failed (${state.code}).`,
        showSubscriptionCta: false,
      };
  }
}

// The best cursor known for a given state, used when forcing a transition to
// "suspended" (see stream.tsx's backgrounding/error-recovery paths) so the
// displayed suspension point is as accurate as possible. Falls back to 0n
// for states that precede the first acknowledged frame -- run()'s own
// store.load() call is always what actually determines the resume point,
// never this value (see projection-store.ts's cursor-only persistence
// trade-off), so 0n here is only ever a display fallback, not a correctness
// concern.
export function cursorOf(state: StreamState): bigint {
  switch (state.kind) {
    case "catching-up":
    case "live":
    case "suspended":
      return state.cursor;
    default:
      return 0n;
  }
}

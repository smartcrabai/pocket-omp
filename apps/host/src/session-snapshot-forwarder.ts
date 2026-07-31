// Converts this Host's OMP session list (packages/host-core's
// OmpSessionSummary[], produced by packages/omp-sdk-adapter's
// OmpSessionListAdapter wrapping SessionManager.list) into a session-protocol
// HostSnapshot and hands it to a HostRelayCoordinator to forward toward the
// paired Mobile device -- the same "build payload, enqueue, never throw"
// shape as ./runtime-event-forwarder.ts's forwardRuntimeEvent, and for the
// same reason: this must never be able to take down HostDaemon just because
// Relay isn't configured yet, no pairwise key exists, or pairing hasn't
// completed (see forwardSessionSnapshot's doc comment below).
//
// ownership (session-protocol's SessionSummary.ownership, which mirrors
// ADR-020's OwnershipState.kind as a plain string): HostDaemon does not
// track per-session ownership state today (ADR-020's state machine is not
// wired into host-daemon.ts -- see runtime-event-forwarder.ts's identical
// note about ownershipEpoch), so there is nothing correct to report for any
// listed session, including the one this Host Daemon is actively running.
// Rather than guessing a value out of OwnershipState's kinds (e.g. reporting
// "pocket-owned" for the active session would assert more than is actually
// tracked), every session is reported with the sentinel "unknown". This is
// deliberately NOT one of ADR-020's OwnershipState.kind values, so Mobile's
// isOwnershipConflict("unknown") (apps/mobile/src/session-view.ts) can never
// misread it as "conflict".
import type {
  HostRelayCoordinator,
  OmpSessionSummary,
  SessionListPort,
} from "@pocket-omp/host-core";
import {
  encodeSecurePayload,
  type HostSnapshot,
  type SessionSummary,
} from "@pocket-omp/session-protocol";

// Mirrors the "v1" convention already used for session-event forwarding (see
// runtime-event-forwarder.ts); capabilitySet is not yet interpreted by
// either side.
const HOST_SNAPSHOT_CAPABILITY_SET = "v1";

/** Reported for every session until HostDaemon tracks ownership (see this module's doc comment above). */
const UNKNOWN_OWNERSHIP = "unknown";

const FALLBACK_TITLE = "Untitled session";

export interface SessionSnapshotRelay {
  /** Only the method this module actually calls, so tests can inject a lightweight fake instead of a real OmpSessionListAdapter. */
  readonly sessionListPort: Pick<SessionListPort, "listSessions">;
  /** Only the method this module actually calls, so tests can inject a lightweight fake instead of a real HostRelayCoordinator. */
  readonly coordinator: Pick<HostRelayCoordinator, "enqueue">;
  /** This route's own Host device id (SecureKeyStore's `route:<routeId>:host-id`, see apps/host/src/pairing.ts and apps/host/src/relay-composition.ts's HostRelayComposition.hostId). */
  readonly hostId: string;
  /** Display name for this Host shown on Mobile (see forwardSessionSnapshot's doc comment for the chosen default). */
  readonly displayName: string;
  /** Resolves the paired Mobile device id to address the snapshot to. Returns undefined when it is not known yet (see apps/host/src/recipient-device-id-learner.ts for how/when it becomes known). */
  readonly recipientDeviceId: () => string | undefined;
  /** Observes a forwarding failure for logging/testing. Forwarding failures never throw out of forwardSessionSnapshot regardless of whether this is provided. */
  readonly onForwardError?: (error: unknown) => void;
}

/**
 * Sends this Host's current OMP session list to Relay as a HostSnapshot,
 * scoped to `cwd` (the Host Daemon's own project directory -- see
 * HostDaemonOptions.cwd), so a paired Mobile device only ever learns about
 * sessions in the project this Host instance is serving, never every
 * project on the machine.
 *
 * A no-op when `relay` is undefined (purely optional path -- see
 * HostDaemonOptions.sessionSnapshot), and never throws: any failure (no
 * relay wired, no recipient known yet, the session list scan failing,
 * Relay/store/crypto failures) is reported via `relay.onForwardError`
 * instead, mirroring runtime-event-forwarder.ts's forwardRuntimeEvent so a
 * forwarding problem can never take down the Host Daemon.
 */
export async function forwardSessionSnapshot(
  cwd: string,
  relay: SessionSnapshotRelay | undefined,
): Promise<void> {
  if (relay === undefined) return;
  try {
    const recipientDeviceId = relay.recipientDeviceId();
    if (recipientDeviceId === undefined || recipientDeviceId.length === 0) {
      throw new SessionSnapshotForwarderError(
        "NO_RECIPIENT",
        "No recipient device id is known yet for this route",
      );
    }
    const sessions = await relay.sessionListPort.listSessions({ cwd });
    const snapshot: HostSnapshot = {
      hostId: relay.hostId,
      displayName: relay.displayName,
      sessions: sessions.map(toSessionSummary),
    };
    const plaintext = encodeSecurePayload({
      capabilitySet: HOST_SNAPSHOT_CAPABILITY_SET,
      body: { kind: "host-snapshot", value: snapshot },
    });
    await relay.coordinator.enqueue(recipientDeviceId, plaintext);
  } catch (error) {
    relay.onForwardError?.(error);
  }
}

/** Converts one host-core OmpSessionSummary into session-protocol's wire-level SessionSummary. Exported for direct unit testing. */
export function toSessionSummary(session: OmpSessionSummary): SessionSummary {
  return {
    sessionId: session.sessionId,
    title: session.title ?? FALLBACK_TITLE,
    cwdDisplayName: cwdDisplayName(session.cwd),
    updatedAtMs: session.updatedAtMs,
    compatibility: session.compatibility,
    ownership: UNKNOWN_OWNERSHIP,
  };
}

/** Basename of `cwd`, for a short display label; falls back to the full path when there's no separator to trim. */
function cwdDisplayName(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const lastSeparator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = lastSeparator === -1 ? trimmed : trimmed.slice(lastSeparator + 1);
  return base.length === 0 ? cwd : base;
}

export class SessionSnapshotForwarderError extends Error {
  public constructor(
    public readonly code: "NO_RECIPIENT",
    message: string,
  ) {
    super(message);
    this.name = "SessionSnapshotForwarderError";
  }
}

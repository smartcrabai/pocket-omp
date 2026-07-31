import { describe, expect, test } from "bun:test";
import { sessionId } from "@pocket-omp/agent-domain";
import type { OmpSessionSummary, SessionListPort } from "@pocket-omp/host-core";
import {
  decodeSecurePayload,
  type HostSnapshot,
  type SecurePayloadBody,
  type SessionSummary,
} from "@pocket-omp/session-protocol";

import {
  forwardSessionSnapshot,
  SessionSnapshotForwarderError,
  toSessionSummary,
  type SessionSnapshotRelay,
} from "../src/session-snapshot-forwarder";

function ompSession(overrides: Partial<OmpSessionSummary> = {}): OmpSessionSummary {
  return {
    sessionId: sessionId("session-1"),
    path: "/home/user/.local/share/omp/sessions/abc/s1.jsonl",
    cwd: "/home/user/project",
    updatedAtMs: 1_700_000_000_000n,
    compatibility: "indeterminate",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toSessionSummary: pure conversion
// ---------------------------------------------------------------------------

describe("toSessionSummary", () => {
  test("passes sessionId/updatedAtMs/compatibility through and derives cwdDisplayName from cwd's basename", () => {
    const summary = toSessionSummary(ompSession({ cwd: "/home/user/my-project" }));
    expect(summary.sessionId).toBe("session-1");
    expect(summary.cwdDisplayName).toBe("my-project");
    expect(summary.updatedAtMs).toBe(1_700_000_000_000n);
    expect(typeof summary.updatedAtMs).toBe("bigint");
    expect(summary.compatibility).toBe("indeterminate");
  });

  test("uses the OMP title when present", () => {
    const summary = toSessionSummary(ompSession({ title: "Fix the flaky test" }));
    expect(summary.title).toBe("Fix the flaky test");
  });

  test("falls back to a placeholder title when OMP has none recorded", () => {
    const summary = toSessionSummary(ompSession());
    expect(summary.title).toBe("Untitled session");
  });

  test("reports ownership as the 'unknown' sentinel (HostDaemon does not track ownership yet)", () => {
    const summary = toSessionSummary(ompSession());
    expect(summary.ownership).toBe("unknown");
    // Never the literal ADR-020 conflict kind, so Mobile's
    // isOwnershipConflict (apps/mobile/src/session-view.ts) never
    // misinterprets "we don't know" as "there is a genuine conflict".
    expect(summary.ownership).not.toBe("conflict");
  });

  test("trims a trailing slash before taking the basename", () => {
    expect(toSessionSummary(ompSession({ cwd: "/home/user/my-project/" })).cwdDisplayName).toBe(
      "my-project",
    );
  });

  test("falls back to the full cwd when there is no path separator to trim", () => {
    expect(toSessionSummary(ompSession({ cwd: "project" })).cwdDisplayName).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// forwardSessionSnapshot: relay wiring
// ---------------------------------------------------------------------------

interface EnqueueCall {
  readonly recipientDeviceId: string;
  readonly plaintext: Uint8Array;
}

function fakeSessionListPort(
  sessions: readonly OmpSessionSummary[],
): Pick<SessionListPort, "listSessions"> {
  return { listSessions: async () => sessions };
}

function fakeRelay(overrides: Partial<SessionSnapshotRelay> = {}): {
  readonly relay: SessionSnapshotRelay;
  readonly calls: EnqueueCall[];
  readonly errors: unknown[];
} {
  const calls: EnqueueCall[] = [];
  const errors: unknown[] = [];
  const relay: SessionSnapshotRelay = {
    sessionListPort: fakeSessionListPort([ompSession()]),
    coordinator: {
      enqueue: async (recipientDeviceId: string, plaintext: Uint8Array) => {
        calls.push({ recipientDeviceId, plaintext });
        return { duplicate: false };
      },
    },
    hostId: "host-1",
    displayName: "Takumi's MacBook",
    recipientDeviceId: () => "mobile-1",
    onForwardError: (error) => errors.push(error),
    ...overrides,
  };
  return { relay, calls, errors };
}

describe("forwardSessionSnapshot", () => {
  test("does nothing when relay is undefined", async () => {
    await forwardSessionSnapshot("/workspace", undefined);
    // No assertion possible beyond "did not throw"; the point is a no-op.
  });

  test("enqueues an encoded host-snapshot SecurePayload addressed to the resolved recipient, scoped to cwd", async () => {
    const listCalls: Array<{ cwd?: string }> = [];
    const { relay, calls, errors } = fakeRelay({
      sessionListPort: {
        listSessions: async (input) => {
          listCalls.push(input);
          return [ompSession({ title: "Investigate flaky CI" })];
        },
      },
    });

    await forwardSessionSnapshot("/workspace/project", relay);

    expect(errors).toEqual([]);
    expect(listCalls).toEqual([{ cwd: "/workspace/project" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.recipientDeviceId).toBe("mobile-1");
    const decoded = decodeSecurePayload(calls[0]?.plaintext ?? new Uint8Array());
    if (decoded.body.kind !== "host-snapshot") throw new Error("expected host-snapshot");
    expect(decoded.body.value.hostId).toBe("host-1");
    expect(decoded.body.value.displayName).toBe("Takumi's MacBook");
    expect(decoded.body.value.sessions).toHaveLength(1);
    expect(decoded.body.value.sessions[0]?.title).toBe("Investigate flaky CI");
  });

  test("reports NO_RECIPIENT and never lists sessions or calls enqueue when no recipient device id is known yet", async () => {
    let listed = false;
    const { relay, calls, errors } = fakeRelay({
      recipientDeviceId: () => undefined,
      sessionListPort: {
        listSessions: async () => {
          listed = true;
          return [];
        },
      },
    });

    await forwardSessionSnapshot("/workspace", relay);

    expect(listed).toBe(false);
    expect(calls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SessionSnapshotForwarderError);
    expect(errors[0]).toMatchObject({ code: "NO_RECIPIENT" });
  });

  test("reports (rather than throws) when the session list port rejects", async () => {
    const { relay, calls, errors } = fakeRelay({
      sessionListPort: {
        listSessions: async () => {
          throw new Error("SessionManager.list failed");
        },
      },
    });

    await forwardSessionSnapshot("/workspace", relay); // must not throw
    expect(calls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]).toMatchObject({ message: "SessionManager.list failed" });
  });

  test("reports (rather than throws) when the relay coordinator's enqueue rejects", async () => {
    const errors: unknown[] = [];
    const relay: SessionSnapshotRelay = {
      sessionListPort: fakeSessionListPort([ompSession()]),
      coordinator: {
        enqueue: async () => {
          throw new Error("relay unavailable");
        },
      },
      hostId: "host-1",
      displayName: "Host",
      recipientDeviceId: () => "mobile-1",
      onForwardError: (error) => errors.push(error),
    };

    await forwardSessionSnapshot("/workspace", relay); // must not throw
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]).toMatchObject({ message: "relay unavailable" });
  });

  test("swallows forwarding failures silently when onForwardError is not provided", async () => {
    const relay: SessionSnapshotRelay = {
      sessionListPort: fakeSessionListPort([]),
      coordinator: { enqueue: async () => ({ duplicate: false }) },
      hostId: "host-1",
      displayName: "Host",
      recipientDeviceId: () => undefined,
    };
    await forwardSessionSnapshot("/workspace", relay); // must not throw despite NO_RECIPIENT
  });

  test("sends an empty session list as an empty HostSnapshot (no sessions is a valid, honest state)", async () => {
    const { relay, calls, errors } = fakeRelay({ sessionListPort: fakeSessionListPort([]) });
    await forwardSessionSnapshot("/workspace", relay);

    expect(errors).toEqual([]);
    const decoded = decodeSecurePayload(calls[0]?.plaintext ?? new Uint8Array());
    if (decoded.body.kind !== "host-snapshot") throw new Error("expected host-snapshot");
    expect(decoded.body.value.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Mobile-side combination: apps/mobile/src/session-view.ts's
// deriveSessionCatalog/isOwnershipConflict are re-implemented here verbatim
// (task instruction: reproduce the same derivation steps in a test rather
// than importing across the apps/host <-> apps/mobile boundary, since
// apps/mobile must not be modified or given a new consumer for this task).
// A ProjectionEvent-shaped object is built the same way
// apps/mobile/src/relay-projection.ts's toProjectionEvent would build one
// for a decoded "host-snapshot" SecurePayload (generic pass-through: kind is
// the SecurePayloadCase discriminant, payload is the decoded domain value),
// without depending on @pocket-omp/mobile-core's ProjectionState/reducer.
// ---------------------------------------------------------------------------

interface FakeProjectionEvent {
  readonly kind: string;
  readonly payload: unknown;
}

// Mirrors apps/mobile/src/session-view.ts's own SessionCatalog type exactly.
type SessionCatalogLikeMobile =
  | { readonly status: "not-fetched" }
  | { readonly status: "loaded"; readonly sessions: readonly SessionSummary[] };

// Mirrors apps/mobile/src/session-view.ts's deriveSessionCatalog exactly
// (last matching host-snapshot event wins), operating on a plain array of
// FakeProjectionEvent instead of mobile-core's full ProjectionState.
function deriveSessionCatalogLikeMobile(
  events: readonly FakeProjectionEvent[],
): SessionCatalogLikeMobile {
  let latest: HostSnapshot | undefined;
  for (const event of events) {
    if (event.kind === "host-snapshot" && isHostSnapshot(event.payload)) {
      latest = event.payload;
    }
  }
  return latest === undefined
    ? { status: "not-fetched" }
    : { status: "loaded", sessions: latest.sessions };
}

// Mirrors apps/mobile/src/session-view.ts's isOwnershipConflict exactly.
function isOwnershipConflictLikeMobile(ownership: string): boolean {
  return ownership === "conflict";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Mirrors apps/mobile/src/session-view.ts's isHostSnapshot exactly.
function isHostSnapshot(value: unknown): value is HostSnapshot {
  return isRecord(value) && "sessions" in value && Array.isArray(value.sessions);
}

describe("Mobile-side receipt (session-view.ts derivation reproduced)", () => {
  test("decodes a forwarded snapshot the same way session-view.ts's deriveSessionCatalog would, and does not flag it as an ownership conflict", async () => {
    const { relay, calls } = fakeRelay({
      sessionListPort: fakeSessionListPort([
        ompSession({ sessionId: sessionId("session-42"), title: "Ship the feature" }),
      ]),
    });
    await forwardSessionSnapshot("/workspace/project", relay);

    const decoded: SecurePayloadBody = decodeSecurePayload(calls[0]?.plaintext ?? new Uint8Array());
    if (decoded.body.kind !== "host-snapshot") throw new Error("expected host-snapshot");

    // relay-projection.ts's toProjectionEvent generic pass-through: kind is
    // the SecurePayloadCase discriminant, payload is the decoded value,
    // sessionId is omitted (host-snapshot is not scoped to one session).
    const projectionEvent: FakeProjectionEvent = {
      kind: decoded.body.kind,
      payload: decoded.body.value,
    };

    const catalog = deriveSessionCatalogLikeMobile([projectionEvent]);
    expect(catalog.status).toBe("loaded");
    if (catalog.status !== "loaded") throw new Error("expected loaded catalog");
    const sessions = catalog.sessions;
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    if (session === undefined) throw new Error("expected a session");
    expect(session.sessionId).toBe("session-42");
    expect(session.title).toBe("Ship the feature");
    expect(session.cwdDisplayName).toBe("project");
    expect(typeof session.updatedAtMs).toBe("bigint");
    expect(session.compatibility).toBe("indeterminate");
    expect(isOwnershipConflictLikeMobile(session.ownership)).toBe(false);
  });

  test("an empty session list still decodes to a 'loaded' catalog with zero sessions, not 'not-fetched'", async () => {
    const { relay, calls } = fakeRelay({ sessionListPort: fakeSessionListPort([]) });
    await forwardSessionSnapshot("/workspace", relay);

    const decoded = decodeSecurePayload(calls[0]?.plaintext ?? new Uint8Array());
    if (decoded.body.kind !== "host-snapshot") throw new Error("expected host-snapshot");
    const catalog = deriveSessionCatalogLikeMobile([
      { kind: decoded.body.kind, payload: decoded.body.value },
    ]);
    expect(catalog).toEqual({ status: "loaded", sessions: [] });
  });
});

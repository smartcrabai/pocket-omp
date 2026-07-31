// Pure, framework-independent derivations over MobileStreamManager's
// ProjectionState (packages/mobile-core/src/index.ts). Used by the UI layer
// (app/index.tsx, app/session/[id].tsx) and directly exercised by `bun
// test`; this module intentionally imports nothing from expo/react-native,
// mirroring the credential-validation.ts / relay-projection.ts split
// documented elsewhere in this directory.
import type { ProjectionEvent, ProjectionState } from "@pocket-omp/mobile-core";
import type {
  DecodedTranscriptEvent,
  HostSnapshot,
  SessionSummary,
} from "@pocket-omp/session-protocol";

export type SessionCatalog =
  | { readonly status: "not-fetched" }
  | { readonly status: "loaded"; readonly sessions: readonly SessionSummary[] };

// relay-projection.ts's toProjectionEvent maps every SecurePayload "host-snapshot"
// delivery to a ProjectionEvent whose `kind` is the literal string
// "host-snapshot" and whose `payload` is the decoded HostSnapshot domain
// object (see its own doc comment on generic pass-through kinds).
// ProjectionState.events preserves arrival order (applyProjectionEvent only
// ever appends), so the *last* such event in the array is always the most
// recently delivered snapshot -- "the newest snapshot wins" is simply "take
// the last match".
export function deriveSessionCatalog(projection: ProjectionState): SessionCatalog {
  let latest: HostSnapshot | undefined;
  for (const event of projection.events) {
    if (event.kind === "host-snapshot" && isHostSnapshot(event.payload)) latest = event.payload;
  }
  return latest === undefined
    ? { status: "not-fetched" }
    : { status: "loaded", sessions: latest.sessions };
}

// Only session-event-derived ProjectionEvents carry a `sessionId` (see
// relay-projection.ts's toProjectionEvent: every other SecurePayloadCase --
// host-snapshot, command-result, approval-request, etc. -- is passed through
// generically with sessionId omitted, never set to another session's id).
// Filtering on it here therefore can never pull in another session's events,
// or non-session-event payloads.
//
// applyProjectionEvent (packages/mobile-core) already enforces strictly
// increasing revisions per session as events are appended, so events for a
// given session arrive in the array already in ascending revision order;
// the explicit sort below is a defensive, cheap guarantee of the ordering
// this function promises rather than a load-bearing reordering step.
export function sessionEventsFor(
  projection: ProjectionState,
  sessionId: string,
): readonly ProjectionEvent[] {
  return projection.events
    .filter((event) => event.sessionId === sessionId)
    .toSorted(compareByRevision);
}

function compareByRevision(left: ProjectionEvent, right: ProjectionEvent): number {
  if (left.revision < right.revision) return -1;
  if (left.revision > right.revision) return 1;
  return 0;
}

// Per ADR-020, "conflict" is the OwnershipState.kind (packages/host-core)
// the Host reports once an external writer (e.g. the OMP TUI acting outside
// Pocket's lock) mutates a session Pocket believed it owned.
// SessionSummary.ownership (packages/session-protocol) carries that same
// string verbatim.
export function isOwnershipConflict(ownership: string): boolean {
  return ownership === "conflict";
}

// Human labels for a session-event's `kind` (packages/agent-domain's
// AgentDomainEvent discriminant, forwarded verbatim by the Host through
// SessionEvent.kind -- see packages/session-protocol/src/index.ts). Falls
// back to the raw kind for forward compatibility with any kind this build
// does not recognize yet, rather than hiding the event.
const SESSION_EVENT_LABELS: Readonly<Record<string, string>> = {
  "agent-started": "Agent started",
  "agent-ended": "Agent finished",
  "agent-failed": "Agent failed",
  "agent-interrupted": "Agent interrupted",
  "message-started": "Message",
  "message-delta": "Message",
  "message-completed": "Message",
  "tool-started": "Tool call",
  "tool-updated": "Tool call",
  "tool-completed": "Tool call",
  "approval-requested": "Approval requested",
  "ui-requested": "Input requested",
  "subagent-started": "Subagent",
  "subagent-updated": "Subagent",
  "subagent-completed": "Subagent",
  "todo-updated": "Todo list updated",
};

export function describeSessionEventKind(kind: string): string {
  return SESSION_EVENT_LABELS[kind] ?? kind;
}

// Reconstructs assistant message text from a session's TranscriptEvent
// stream and renders a handful of other decoded kinds as their own rows.
// This is this task's actual deliverable: previously, app/session/[id].tsx's
// TranscriptRow could only show an event's `kind` label and byte count,
// because SessionEvent.payload was still raw, opaque bytes. Now that
// relay-projection.ts's toProjectionEvent decodes payload into a
// DecodedTranscriptEvent (packages/session-protocol) before it ever reaches
// here, this derives an ordered list of rows a screen can render directly.
//
// message-started/message-delta/message-completed collapse into a single
// "message" row per messageId, updated in place as more deltas arrive,
// rather than one row per event -- this is the "reconstruct the message text
// by concatenating deltas in revision order" requirement. Concatenation
// order is revision order, not array-arrival order: `events` is defensively
// re-sorted by revision here (mirroring sessionEventsFor's own defensive
// sort above), so interleaved messageIds and out-of-order delivery both
// still concatenate correctly -- a message's own deltas can never be
// reordered relative to each other (they share one session-wide revision
// counter), only interleaved with another message's, so sorting the whole
// list once before grouping by messageId is sufficient.
//
// tool-started/-updated/-completed, todo-updated, and
// agent-ended/-failed/-interrupted each become their own row.
// agent-started/subagent-*/approval-requested/ui-requested (recognized
// kinds this build simply has no rich rendering for yet -- ApprovalCard
// wiring in particular is explicitly out of scope, see app/session/[id].tsx)
// fall back to a plain label row via describeSessionEventKind, so they
// still show up in the feed rather than vanishing. A genuinely unrecognized
// oneof case ("unknown", see DecodedTranscriptEvent) is dropped entirely
// instead: there is nothing safe to say about a payload shape this build
// has never seen (see decodeTranscriptEvent's own doc comment on why that
// case exists at all).
export type TranscriptRow =
  | {
      readonly key: string;
      readonly kind: "message";
      readonly text: string;
      readonly complete: boolean;
    }
  | {
      readonly key: string;
      readonly kind: "tool";
      readonly toolName: string;
      readonly phase: "started" | "updated" | "completed";
    }
  | {
      readonly key: string;
      readonly kind: "todo";
      readonly items: readonly {
        readonly id: string;
        readonly text: string;
        readonly status: string;
      }[];
    }
  | {
      readonly key: string;
      readonly kind: "agent-finished";
      readonly outcome: "ended" | "failed" | "interrupted";
      readonly reason?: string;
    }
  | { readonly key: string; readonly kind: "label"; readonly text: string };

export function reconstructTranscript(
  events: readonly ProjectionEvent[],
): readonly TranscriptRow[] {
  const ordered = events.toSorted(compareByRevision);
  const rows: TranscriptRow[] = [];
  const messageRowIndex = new Map<string, number>();
  for (const event of ordered) {
    const body = event.payload;
    if (!isDecodedTranscriptEvent(body)) continue;
    switch (body.kind) {
      case "message-started":
        ensureMessageRow(rows, messageRowIndex, body.messageId);
        break;
      case "message-delta": {
        const index = ensureMessageRow(rows, messageRowIndex, body.messageId);
        const row = rows[index];
        if (row !== undefined && row.kind === "message") {
          rows[index] = { ...row, text: row.text + body.delta };
        }
        break;
      }
      case "message-completed": {
        const index = messageRowIndex.get(body.messageId);
        if (index !== undefined) {
          const row = rows[index];
          if (row !== undefined && row.kind === "message") rows[index] = { ...row, complete: true };
        }
        break;
      }
      case "tool-started":
      case "tool-updated":
      case "tool-completed":
        rows.push({
          key: event.eventId,
          kind: "tool",
          toolName: body.toolName,
          phase: toolPhaseOf(body.kind),
        });
        break;
      case "todo-updated":
        rows.push({ key: event.eventId, kind: "todo", items: body.items });
        break;
      case "agent-ended":
      case "agent-failed":
      case "agent-interrupted":
        rows.push({
          key: event.eventId,
          kind: "agent-finished",
          outcome: agentOutcomeOf(body.kind),
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        });
        break;
      case "agent-started":
      case "subagent-started":
      case "subagent-updated":
      case "subagent-completed":
      case "approval-requested":
      case "ui-requested":
        rows.push({
          key: event.eventId,
          kind: "label",
          text: describeSessionEventKind(event.kind),
        });
        break;
      case "unknown":
        break;
    }
  }
  return rows;
}

function ensureMessageRow(
  rows: TranscriptRow[],
  index: Map<string, number>,
  messageId: string,
): number {
  const existing = index.get(messageId);
  if (existing !== undefined) return existing;
  const position = rows.length;
  index.set(messageId, position);
  rows.push({ key: `message:${messageId}`, kind: "message", text: "", complete: false });
  return position;
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new tool kind fails to compile.
function toolPhaseOf(
  kind: "tool-started" | "tool-updated" | "tool-completed",
): "started" | "updated" | "completed" {
  switch (kind) {
    case "tool-started":
      return "started";
    case "tool-updated":
      return "updated";
    case "tool-completed":
      return "completed";
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new outcome kind fails to compile.
function agentOutcomeOf(
  kind: "agent-ended" | "agent-failed" | "agent-interrupted",
): "ended" | "failed" | "interrupted" {
  switch (kind) {
    case "agent-ended":
      return "ended";
    case "agent-failed":
      return "failed";
    case "agent-interrupted":
      return "interrupted";
  }
}

// Defensive structural check that a decoded ProjectionEvent.payload really is
// a DecodedTranscriptEvent before switching on its `kind` -- mirrors
// isHostSnapshot below for the same reason (ProjectionEvent.payload is typed
// `unknown`, since packages/mobile-core deliberately knows nothing about
// session-protocol's domain types).
function isDecodedTranscriptEvent(value: unknown): value is DecodedTranscriptEvent {
  return isRecord(value) && typeof value.kind === "string";
}

// The Host/session-protocol boundary (openSecurePayload) already validates
// the encrypted payload's shape at decode time; this is a defensive runtime
// check that a given `unknown` projection payload really is a HostSnapshot
// before treating it as one, since ProjectionEvent.payload is typed
// `unknown` (packages/mobile-core deliberately knows nothing about
// session-protocol's domain types).
function isHostSnapshot(value: unknown): value is HostSnapshot {
  return isRecord(value) && "sessions" in value && Array.isArray(value.sessions);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

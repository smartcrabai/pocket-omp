// Converts a decrypted SecurePayload (packages/session-protocol) into the
// generic ProjectionEvent shape MobileStreamManager's projection reducer
// operates on (packages/mobile-core/src/index.ts). This module intentionally
// imports nothing from expo/react-native so it can be exercised directly by
// `bun test`, mirroring the credential-validation.ts / credentials.ts split.
//
// Handling of SecurePayloadCase kinds other than "session-event":
//
// SessionEvent is the only SecurePayloadCase variant that carries its own
// identity (eventId + revision + sessionId), which is exactly what
// ADR-006 designates as Mobile's idempotency key and what
// applyProjectionEvent (packages/mobile-core) uses to dedupe/order events.
// Every other variant (host-snapshot, session-snapshot, command-accepted,
// command-result, approval-request, approval-response, ui-request,
// ui-response, attachment-manifest, device-hello, command, error) has no
// such identity of its own.
//
// Rather than dropping those payloads on the floor -- which would silently
// discard real, user-visible state such as a failed CommandResult or a
// pending ApprovalRequest with no other delivery path to the UI -- they are
// passed through generically:
//   - `kind` is the SecurePayloadCase discriminant itself (e.g.
//     "host-snapshot", "command-result"), so a future projection reducer can
//     switch on it the same way it would switch on a session-event's own
//     `kind` (e.g. "message").
//   - `eventId` falls back to the relay envelope's `message_id`. The relay
//     already treats `sender_device_id + message_id` as a unique
//     idempotency key (ADR-006), so redeliveries of the same envelope are
//     still deduplicated by applyProjectionEvent even though these variants
//     carry no revision of their own.
//   - `sessionId` is omitted entirely (not set to `undefined`, which
//     exactOptionalPropertyTypes forbids for an optional field): these
//     variants are not scoped to a session revision, so
//     applyProjectionEvent's revision-monotonicity check -- which only runs
//     when sessionId is set -- correctly never applies to them.
//   - `revision` is set to 0n as a placeholder; it is never consulted
//     because sessionId is absent.
//
// A session-event's own `payload` is no longer passed through as opaque
// bytes: it is a versioned Protobuf TranscriptEvent (see the doc comment on
// TranscriptEvent in proto/pocket/omp/session/v1/session.proto for why this
// boundary -- unlike Runtime<->Host -- needs that instead of JSON), decoded
// here via decodeTranscriptEvent into the DecodedTranscriptEvent domain
// shape session-view.ts's reconstructTranscript operates on.
// decodeTranscriptEvent can throw SessionProtocolError for a genuinely
// malformed/corrupted payload or a kind/phase mismatch; that propagates
// exactly like a malformed envelope already does from openSecurePayload
// upstream (no special handling here), while a forward-compatible but
// unrecognized oneof case (a Host built against a newer proto) decodes to
// `{ kind: "unknown" }` rather than throwing -- see decodeTranscriptEvent's
// own doc comment.
import type { ProjectionEvent } from "@pocket-omp/mobile-core";
import { decodeTranscriptEvent, type SecurePayloadBody } from "@pocket-omp/session-protocol";

export function toProjectionEvent(
  envelopeMessageId: string,
  body: SecurePayloadBody,
): ProjectionEvent {
  if (body.body.kind === "session-event") {
    const event = body.body.value;
    return {
      eventId: event.eventId,
      sessionId: event.sessionId,
      revision: event.revision,
      kind: event.kind,
      payload: decodeTranscriptEvent(event.kind, event.payload),
    };
  }
  return {
    eventId: envelopeMessageId,
    revision: 0n,
    kind: body.body.kind,
    payload: body.body.value,
  };
}

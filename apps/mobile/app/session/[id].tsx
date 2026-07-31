import { useLocalSearchParams } from "expo-router";
import { useMemo, useState, type ReactElement } from "react";
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  deriveSessionCatalog,
  isOwnershipConflict,
  reconstructTranscript,
  sessionEventsFor,
  type TranscriptRow,
} from "../../src/session-view";
import { useStream } from "../../src/stream";
import { palette, spacing } from "../../src/theme";

type Surface = "transcript" | "files" | "git" | "attachments";

export default function SessionScreen(): ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [surface, setSurface] = useState<Surface>("transcript");
  const [prompt, setPrompt] = useState("");
  const stream = useStream();
  const title = useMemo(() => (id === undefined ? "Unknown session" : id), [id]);
  const events = useMemo(
    () => (id === undefined ? [] : sessionEventsFor(stream.projection, id)),
    [stream.projection, id],
  );
  const rows = useMemo(() => reconstructTranscript(events), [events]);
  const catalog = useMemo(() => deriveSessionCatalog(stream.projection), [stream.projection]);
  const summary =
    catalog.status === "loaded"
      ? catalog.sessions.find((item) => item.sessionId === id)
      : undefined;
  const conflicted = summary !== undefined && isOwnershipConflict(summary.ownership);

  return (
    <SafeAreaView style={styles.shell}>
      <View style={styles.header}>
        <Text style={styles.step}>SESSION / ENCRYPTED</Text>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        {conflicted ? (
          <View accessibilityRole="alert" style={styles.conflictBanner}>
            <Text style={styles.conflictText}>
              Ownership conflict: something outside Pocket modified this session. Resolve it on the
              Host (see ADR-020) before sending anything further.
            </Text>
          </View>
        ) : null}
        <View style={styles.tabs}>
          {(["transcript", "files", "git", "attachments"] as const).map((item) => (
            <Pressable
              key={item}
              accessibilityRole="tab"
              accessibilityState={{ selected: surface === item }}
              onPress={() => setSurface(item)}
              style={[styles.tab, surface === item && styles.tabSelected]}
            >
              <Text style={[styles.tabText, surface === item && styles.tabTextSelected]}>
                {item.toUpperCase()}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <ScrollView style={styles.feed} contentContainerStyle={styles.feedContent}>
        {surface === "transcript" ? (
          rows.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Waiting for the encrypted session projection.</Text>
              <Text style={styles.body}>
                Messages, tool cards, subagents, approvals, and Todo changes appear here after the
                Relay cursor catches up.
              </Text>
            </View>
          ) : (
            <View style={styles.transcript}>
              {rows.map((row) => (
                <TranscriptRowView key={row.key} row={row} />
              ))}
            </View>
          )
        ) : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No {surface} payload has been received.</Text>
            <Text style={styles.body}>
              Host policy and canonical path checks remain authoritative for every request.
            </Text>
          </View>
        )}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          accessibilityLabel="Prompt or follow-up"
          multiline
          value={prompt}
          onChangeText={setPrompt}
          placeholder="Sending prompts from Pocket isn't available yet"
          placeholderTextColor={palette.muted}
          style={styles.input}
          // Deliberately still disabled. Submitting a prompt means sending a
          // ClientCommand("submit-prompt") over the Relay (packages/
          // session-protocol) and reconciling the runtime's
          // CommandAccepted/CommandResult -- and responding to an
          // ApprovalCard below means the same for
          // ClientCommandCase("respond-to-approval"). Both are explicitly
          // out of scope for this task (wiring MobileStreamManager's
          // read/projection side); a follow-up task re-enables `editable`
          // here (and the send button's `disabled` state below) once that
          // upstream command path exists.
          editable={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: true }}
          accessibilityLabel="Sending prompts is not available yet"
          style={styles.send}
        >
          <Text style={styles.sendText}>SEND</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

// Renders one reconstructed transcript row (src/session-view.ts's
// reconstructTranscript). Unlike the earlier revision of this screen,
// SessionEvent.payload is decoded by this point (relay-projection.ts decodes
// it into a DecodedTranscriptEvent as soon as it arrives -- see that file's
// doc comment), so this can show an assistant message's actual reconstructed
// text instead of just its `kind` label and byte count.
// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed TranscriptRow union; a new row kind fails to compile.
function TranscriptRowView({ row }: { readonly row: TranscriptRow }): ReactElement {
  switch (row.kind) {
    case "message":
      return (
        <View style={styles.transcriptRow}>
          <Text style={styles.transcriptKind}>{row.complete ? "Message" : "Message …"}</Text>
          <Text style={styles.messageText}>{row.text.length > 0 ? row.text : "…"}</Text>
        </View>
      );
    case "tool":
      return (
        <View style={styles.transcriptRow}>
          <View style={styles.transcriptBody}>
            <Text style={styles.transcriptKind}>{row.toolName}</Text>
            <Text style={styles.transcriptMeta}>{describeToolPhase(row.phase)}</Text>
          </View>
        </View>
      );
    case "todo":
      return (
        <View style={styles.transcriptRow}>
          <Text style={styles.transcriptKind}>Todo list updated</Text>
          {row.items.map((item) => (
            <View key={item.id} style={styles.todoItemRow}>
              <Text style={styles.todoItemStatus}>{describeTodoStatus(item.status)}</Text>
              <Text style={styles.todoItemText}>{item.text}</Text>
            </View>
          ))}
        </View>
      );
    case "agent-finished":
      return (
        <View style={styles.transcriptRow}>
          <Text style={styles.transcriptKind}>{describeAgentOutcome(row.outcome)}</Text>
          {row.reason === undefined ? null : <Text style={styles.body}>{row.reason}</Text>}
        </View>
      );
    case "label":
      return (
        <View style={styles.transcriptRow}>
          <Text style={styles.transcriptKind}>{row.text}</Text>
        </View>
      );
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new phase fails to compile.
function describeToolPhase(phase: "started" | "updated" | "completed"): string {
  switch (phase) {
    case "started":
      return "Started";
    case "updated":
      return "Updated";
    case "completed":
      return "Completed";
  }
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed literal union; a new outcome fails to compile.
function describeAgentOutcome(outcome: "ended" | "failed" | "interrupted"): string {
  switch (outcome) {
    case "ended":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "interrupted":
      return "Agent interrupted";
  }
}

// TranscriptRow's todo item `status` is a plain string (see session-view.ts),
// so unlike describeToolPhase/describeAgentOutcome above this is not an
// exhaustive switch over a closed union -- the default falls back to the raw
// status for forward compatibility with any TranscriptTodoStatus this build
// doesn't recognize yet, mirroring describeSessionEventKind's own fallback.
function describeTodoStatus(status: string): string {
  switch (status) {
    case "pending":
      return "TODO";
    case "in-progress":
      return "DOING";
    case "completed":
      return "DONE";
    case "cancelled":
      return "SKIPPED";
    default:
      return status.toUpperCase();
  }
}

// Not yet wired into SessionScreen above: `approval-request` SecurePayload
// deliveries reach the projection as generic pass-through ProjectionEvents
// (see relay-projection.ts), deduplicated only by envelope message id, with
// no signal in the projection today that links a later approval-response
// (or command-result) back to the request it resolved. Rendering this
// read-only -- the safer-looking of the two options this task allows -- would
// mean an already-answered approval (answered from another device, or from
// the Host's own TUI) keeps showing "approval required" indefinitely, which
// is worse than today's honest empty state. This is deferred to the same
// follow-up task that wires respond-to-approval (see the composer's comment
// above): once responses round-trip, the same event can be correlated and
// retired.
export function ApprovalCard(props: {
  readonly summary: string;
  readonly expiresAtMs: bigint;
  readonly onDecision: (allow: boolean) => void;
}): ReactElement {
  return (
    <View accessibilityRole="summary" style={styles.approval}>
      <Text style={styles.approvalLabel}>HOST APPROVAL REQUIRED</Text>
      <Text style={styles.approvalSummary}>{props.summary}</Text>
      <Text style={styles.body}>
        Expires {new Date(Number(props.expiresAtMs)).toLocaleTimeString()}
      </Text>
      <View style={styles.approvalActions}>
        <Pressable
          accessibilityRole="button"
          style={styles.reject}
          onPress={() => props.onDecision(false)}
        >
          <Text style={styles.rejectText}>DENY</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.allow}
          onPress={() => props.onDecision(true)}
        >
          <Text style={styles.allowText}>ALLOW ONCE</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: palette.ink },
  header: { padding: spacing.md, gap: spacing.sm, borderBottomWidth: 1, borderColor: palette.line },
  step: { color: palette.signal, fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: palette.paper, fontSize: 24, fontWeight: "400" },
  conflictBanner: {
    backgroundColor: palette.panel,
    borderLeftWidth: 3,
    borderColor: palette.danger,
    padding: spacing.sm,
  },
  conflictText: { color: palette.danger, fontSize: 13, lineHeight: 19 },
  tabs: { flexDirection: "row", gap: spacing.xs },
  tab: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 2,
    borderColor: "transparent",
  },
  tabSelected: { borderColor: palette.signal },
  tabText: { color: palette.muted, fontSize: 9, fontWeight: "700" },
  tabTextSelected: { color: palette.signal },
  feed: { flex: 1 },
  feedContent: { padding: spacing.md },
  empty: {
    minHeight: 280,
    justifyContent: "center",
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  emptyTitle: { color: palette.paper, fontSize: 22, lineHeight: 28 },
  body: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  transcript: { gap: spacing.sm },
  transcriptRow: {
    gap: spacing.xs,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
    padding: spacing.sm,
  },
  transcriptBody: { flex: 1, flexDirection: "row", justifyContent: "space-between" },
  transcriptKind: { color: palette.paper, fontSize: 14, fontWeight: "700" },
  transcriptMeta: { color: palette.muted, fontSize: 11 },
  messageText: { color: palette.paper, fontSize: 15, lineHeight: 22 },
  todoItemRow: { flexDirection: "row", gap: spacing.xs, alignItems: "center" },
  todoItemStatus: { color: palette.signal, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  todoItemText: { color: palette.paper, fontSize: 13, flexShrink: 1 },
  composer: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderColor: palette.line,
    flexDirection: "row",
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    minHeight: 50,
    maxHeight: 120,
    color: palette.paper,
    backgroundColor: palette.panel,
    padding: spacing.md,
  },
  send: {
    width: 64,
    backgroundColor: palette.raised,
    alignItems: "center",
    justifyContent: "center",
    opacity: 0.5,
  },
  sendText: { color: palette.muted, fontWeight: "800" },
  approval: {
    backgroundColor: palette.panel,
    borderLeftWidth: 3,
    borderColor: palette.warning,
    padding: spacing.md,
    gap: spacing.sm,
  },
  approvalLabel: { color: palette.warning, fontSize: 10, fontWeight: "900", letterSpacing: 1.3 },
  approvalSummary: { color: palette.paper, fontSize: 18 },
  approvalActions: { flexDirection: "row", gap: spacing.sm },
  reject: {
    flex: 1,
    minHeight: 48,
    borderWidth: 1,
    borderColor: palette.line,
    alignItems: "center",
    justifyContent: "center",
  },
  rejectText: { color: palette.paper, fontWeight: "800" },
  allow: {
    flex: 2,
    minHeight: 48,
    backgroundColor: palette.warning,
    alignItems: "center",
    justifyContent: "center",
  },
  allowText: { color: palette.ink, fontWeight: "900" },
});

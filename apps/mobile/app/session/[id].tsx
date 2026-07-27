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
import { palette, spacing } from "../../src/theme";

type Surface = "transcript" | "files" | "git" | "attachments";

export default function SessionScreen(): ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [surface, setSurface] = useState<Surface>("transcript");
  const [prompt, setPrompt] = useState("");
  const title = useMemo(() => (id === undefined ? "Unknown session" : id), [id]);
  return (
    <SafeAreaView style={styles.shell}>
      <View style={styles.header}>
        <Text style={styles.step}>SESSION / ENCRYPTED</Text>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
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
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Waiting for the encrypted session projection.</Text>
            <Text style={styles.body}>
              Messages, tool cards, subagents, approvals, and Todo changes appear here after the
              Relay cursor catches up.
            </Text>
          </View>
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
          placeholder="Send a prompt after this session is live"
          placeholderTextColor={palette.muted}
          style={styles.input}
          editable={false}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: true }}
          style={styles.send}
        >
          <Text style={styles.sendText}>SEND</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

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

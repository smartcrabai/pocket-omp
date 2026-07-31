import { router } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ReactElement } from "react";
import type { SessionSummary } from "@pocket-omp/session-protocol";
import { useAuth } from "../src/auth";
import { deriveSessionCatalog, isOwnershipConflict } from "../src/session-view";
import { useStream } from "../src/stream";
import { describeStreamState, type StreamDisplay, type StreamTone } from "../src/stream-display";
import { palette, spacing } from "../src/theme";

export default function HomeScreen(): ReactElement {
  const auth = useAuth();
  if (auth.loading)
    return (
      <SafeAreaView style={styles.loading}>
        <ActivityIndicator color={palette.signal} accessibilityLabel="Loading secure account" />
      </SafeAreaView>
    );
  if (auth.accessToken === undefined) {
    return (
      <SafeAreaView style={styles.shell}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>POCKET OMP / REMOTE OPERATIONS</Text>
          <Text style={styles.title}>Your agent, within reach.</Text>
          <Text style={styles.body}>
            Pair a trusted computer. Review every sensitive action. Keep provider credentials on the
            Host.
          </Text>
          <Pressable
            accessibilityRole="button"
            testID="sign-in-button"
            style={styles.primary}
            onPress={() => router.push("/sign-in")}
          >
            <Text style={styles.primaryText}>SIGN IN SECURELY</Text>
          </Pressable>
        </View>
        <View style={styles.securityStrip}>
          <Text style={styles.stripText}>PAIRWISE E2EE</Text>
          <Text style={styles.stripText}>HOST-ENFORCED POLICY</Text>
        </View>
      </SafeAreaView>
    );
  }
  return <SignedInHome />;
}

function SignedInHome(): ReactElement {
  const stream = useStream();
  const display = describeStreamState(stream.state, stream.runFailure);
  const catalog = deriveSessionCatalog(stream.projection);
  return (
    <SafeAreaView style={styles.shell}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topline}>
          <View>
            <Text style={styles.eyebrow}>LIVE CONTROL</Text>
            <Text style={styles.heading}>Sessions</Text>
          </View>
          {stream.hasRoute ? <StatusPill display={display} /> : null}
        </View>
        {display.showSubscriptionCta ? (
          <Pressable
            accessibilityRole="button"
            style={styles.noticeWarning}
            onPress={() => router.push("/subscription")}
          >
            <Text style={styles.noticeTitleWarning}>SUBSCRIPTION REQUIRED</Text>
            <Text style={styles.body}>{display.detail} Tap to open Relay Pro.</Text>
          </Pressable>
        ) : null}
        {display.tone === "fatal" ? (
          <View style={styles.noticeDanger}>
            <Text style={styles.noticeTitleDanger}>CONNECTION PROBLEM</Text>
            <Text style={styles.body}>{display.detail}</Text>
            <Pressable accessibilityRole="button" style={styles.retry} onPress={stream.retry}>
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
          </View>
        ) : null}
        <SessionList hasRoute={stream.hasRoute} catalog={catalog} />
        <Pressable
          accessibilityRole="button"
          testID="pair-host-button"
          style={styles.primary}
          onPress={() => router.push("/pair")}
        >
          <Text style={styles.primaryText}>PAIR A HOST</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.secondary}
          onPress={() => router.push("/devices")}
        >
          <Text style={styles.secondaryText}>MANAGE DEVICES</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.secondary}
          onPress={() => router.push("/subscription")}
        >
          <Text style={styles.secondaryText}>RELAY PRO</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function SessionList(props: {
  readonly hasRoute: boolean;
  readonly catalog: ReturnType<typeof deriveSessionCatalog>;
}): ReactElement {
  if (!props.hasRoute) {
    return (
      <View style={styles.empty} accessibilityLabel="No active sessions">
        <Text style={styles.emptyIndex}>00 / ACTIVE</Text>
        <Text style={styles.emptyTitle}>No session is running.</Text>
        <Text style={styles.body}>
          Pair a Host, then start or resume an OMP session from its catalog.
        </Text>
      </View>
    );
  }
  if (props.catalog.status === "not-fetched") {
    return (
      <View style={styles.empty} accessibilityLabel="Sessions not yet loaded">
        <Text style={styles.emptyIndex}>00 / ACTIVE</Text>
        <Text style={styles.emptyTitle}>Waiting for the Host's first snapshot.</Text>
        <Text style={styles.body}>
          The session catalog appears here as soon as the Relay delivers it.
        </Text>
      </View>
    );
  }
  if (props.catalog.sessions.length === 0) {
    return (
      <View style={styles.empty} accessibilityLabel="No active sessions">
        <Text style={styles.emptyIndex}>00 / ACTIVE</Text>
        <Text style={styles.emptyTitle}>No session is running.</Text>
        <Text style={styles.body}>Start or resume an OMP session on the Host to see it here.</Text>
      </View>
    );
  }
  return (
    <View style={styles.list}>
      {props.catalog.sessions.map((session) => (
        <SessionRow key={session.sessionId} session={session} />
      ))}
    </View>
  );
}

function SessionRow({ session }: { readonly session: SessionSummary }): ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      testID={`session-row-${session.sessionId}`}
      style={styles.row}
      onPress={() => router.push(`/session/${session.sessionId}`)}
    >
      <View style={styles.rowHeader}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {session.title}
        </Text>
        {isOwnershipConflict(session.ownership) ? (
          <Text style={styles.conflictBadge}>CONFLICT</Text>
        ) : null}
      </View>
      <Text numberOfLines={1} style={styles.rowSubtitle}>
        {session.cwdDisplayName}
      </Text>
      <View style={styles.rowFooter}>
        <Text style={styles.rowMeta}>{formatUpdatedAt(session.updatedAtMs)}</Text>
        {session.compatibility === "fully-compatible" ? null : (
          <Text style={styles.compatibilityBadge}>{session.compatibility}</Text>
        )}
      </View>
    </Pressable>
  );
}

function StatusPill({ display }: { readonly display: StreamDisplay }): ReactElement {
  return (
    <View style={styles.live}>
      <View style={[styles.dot, toneDotStyle(display.tone)]} />
      <Text style={styles.liveText}>{display.label}</Text>
    </View>
  );
}

// oxlint-disable-next-line typescript/consistent-return -- switch is exhaustive over the closed StreamTone union; a new case fails to compile.
function toneDotStyle(tone: StreamTone): { backgroundColor: string } {
  switch (tone) {
    case "live":
      return { backgroundColor: palette.signal };
    case "syncing":
    case "connecting":
    case "reauthenticating":
      return { backgroundColor: palette.warning };
    case "retrying":
    case "entitlement-required":
    case "fatal":
      return { backgroundColor: palette.danger };
    case "suspended":
      return { backgroundColor: palette.muted };
  }
}

function formatUpdatedAt(updatedAtMs: bigint): string {
  return new Date(Number(updatedAtMs)).toLocaleString();
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: palette.ink },
  loading: {
    flex: 1,
    backgroundColor: palette.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  content: { padding: spacing.lg, gap: spacing.md },
  hero: { flex: 1, justifyContent: "center", padding: spacing.lg, gap: spacing.lg },
  eyebrow: { color: palette.signal, fontSize: 11, fontWeight: "800", letterSpacing: 1.8 },
  title: {
    color: palette.paper,
    fontSize: 52,
    lineHeight: 54,
    fontWeight: "300",
    letterSpacing: -2,
  },
  heading: { color: palette.paper, fontSize: 36, fontWeight: "300" },
  body: { color: palette.muted, fontSize: 16, lineHeight: 24 },
  primary: {
    minHeight: 54,
    backgroundColor: palette.signal,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  primaryText: { color: palette.ink, fontWeight: "900", letterSpacing: 1 },
  secondary: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: palette.line,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryText: { color: palette.paper, fontWeight: "700", letterSpacing: 1 },
  securityStrip: {
    borderTopWidth: 1,
    borderColor: palette.line,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: spacing.md,
  },
  stripText: { color: palette.muted, fontSize: 10, letterSpacing: 1 },
  topline: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  live: { flexDirection: "row", alignItems: "center", gap: spacing.xs, marginTop: spacing.sm },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: palette.signal },
  liveText: { color: palette.signal, fontSize: 10, fontWeight: "800" },
  empty: {
    minHeight: 280,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
    padding: spacing.lg,
    justifyContent: "flex-end",
    gap: spacing.sm,
  },
  emptyIndex: {
    position: "absolute",
    top: spacing.md,
    right: spacing.md,
    color: palette.muted,
    fontSize: 10,
  },
  emptyTitle: { color: palette.paper, fontSize: 24, fontWeight: "500" },
  noticeWarning: {
    backgroundColor: palette.panel,
    borderLeftWidth: 3,
    borderColor: palette.warning,
    padding: spacing.md,
    gap: spacing.xs,
  },
  noticeTitleWarning: { color: palette.warning, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  noticeDanger: {
    backgroundColor: palette.panel,
    borderLeftWidth: 3,
    borderColor: palette.danger,
    padding: spacing.md,
    gap: spacing.sm,
  },
  noticeTitleDanger: { color: palette.danger, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  retry: {
    alignSelf: "flex-start",
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: palette.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  retryText: { color: palette.danger, fontWeight: "800", letterSpacing: 1 },
  list: { gap: spacing.sm },
  row: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
    padding: spacing.md,
    gap: spacing.xs,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowTitle: { flex: 1, color: palette.paper, fontSize: 18, fontWeight: "500" },
  rowSubtitle: { color: palette.muted, fontSize: 13 },
  rowFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowMeta: { color: palette.muted, fontSize: 11 },
  conflictBadge: {
    color: palette.danger,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1,
    marginLeft: spacing.sm,
  },
  compatibilityBadge: { color: palette.warning, fontSize: 10, fontWeight: "700" },
});

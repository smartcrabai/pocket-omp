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
import { useAuth } from "../src/auth";
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
  return (
    <SafeAreaView style={styles.shell}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topline}>
          <View>
            <Text style={styles.eyebrow}>LIVE CONTROL</Text>
            <Text style={styles.heading}>Sessions</Text>
          </View>
          <View style={styles.live}>
            <View style={styles.dot} />
            <Text style={styles.liveText}>RELAY READY</Text>
          </View>
        </View>
        <View style={styles.empty} accessibilityLabel="No active sessions">
          <Text style={styles.emptyIndex}>00 / ACTIVE</Text>
          <Text style={styles.emptyTitle}>No session is running.</Text>
          <Text style={styles.body}>
            Pair a Host, then start or resume an OMP session from its catalog.
          </Text>
        </View>
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
});

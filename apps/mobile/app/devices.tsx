import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { useEffect, useState, type ReactElement } from "react";
import { Alert, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../src/auth";
import { palette, spacing } from "../src/theme";

export default function DevicesScreen(): ReactElement {
  const auth = useAuth();
  const [routes, setRoutes] = useState<string[]>([]);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    void loadRoutes()
      .then(setRoutes)
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : "Unable to read paired devices"),
      );
  }, []);
  const revoke = async (routeId: string): Promise<void> => {
    const controlUrl = process.env.EXPO_PUBLIC_CONTROL_URL;
    if (controlUrl === undefined || auth.accessToken === undefined) {
      setFailure("Control Plane is not configured");
      return;
    }
    const response = await fetch(`${controlUrl}/v1/routes/${encodeURIComponent(routeId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    if (!response.ok) {
      setFailure(`Device revocation failed (${response.status})`);
      return;
    }
    const remaining = routes.filter((id) => id !== routeId);
    await Promise.all([
      SecureStore.deleteItemAsync(`route.${routeId}.key`),
      SecureStore.setItemAsync("pocket-omp.paired-routes", JSON.stringify(remaining)),
    ]);
    setRoutes(remaining);
  };
  return (
    <SafeAreaView style={styles.shell}>
      <View style={styles.header}>
        <Text style={styles.step}>SECURITY / ROUTES</Text>
        <Text style={styles.title}>Paired devices</Text>
        <Text style={styles.body}>
          Revocation removes the local pairwise key and immediately invalidates the route at the
          Control Plane.
        </Text>
      </View>
      {routes.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.body}>No Host routes are paired.</Text>
        </View>
      ) : (
        routes.map((routeId) => (
          <View key={routeId} style={styles.row}>
            <View>
              <Text style={styles.label}>HOST ROUTE</Text>
              <Text selectable style={styles.route}>
                {routeId}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Revoke route ${routeId}`}
              style={styles.danger}
              onPress={() =>
                Alert.alert(
                  "Revoke this Host?",
                  "Pending commands from this route will stop immediately.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Revoke",
                      style: "destructive",
                      onPress: () => {
                        void revoke(routeId);
                      },
                    },
                  ],
                )
              }
            >
              <Text style={styles.dangerText}>REVOKE</Text>
            </Pressable>
          </View>
        ))
      )}
      {failure === undefined ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {failure}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        style={styles.signOut}
        onPress={() => {
          void auth.signOut().then(() => router.replace("/"));
        }}
      >
        <Text style={styles.signOutText}>SIGN OUT THIS DEVICE</Text>
      </Pressable>
    </SafeAreaView>
  );
}

async function loadRoutes(): Promise<string[]> {
  const raw = await SecureStore.getItemAsync("pocket-omp.paired-routes");
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error("Paired route index is corrupt");
  return value;
}
const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: palette.ink, padding: spacing.lg, gap: spacing.md },
  header: { gap: spacing.sm, marginBottom: spacing.md },
  step: { color: palette.signal, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: palette.paper, fontSize: 36, fontWeight: "300" },
  body: { color: palette.muted, fontSize: 15, lineHeight: 22 },
  empty: {
    padding: spacing.lg,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
  },
  row: {
    padding: spacing.md,
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
    gap: spacing.md,
  },
  label: { color: palette.muted, fontSize: 10, letterSpacing: 1.2 },
  route: { color: palette.paper, marginTop: spacing.xs },
  danger: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: palette.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerText: { color: palette.danger, fontWeight: "800" },
  error: { color: palette.danger },
  signOut: { marginTop: "auto", minHeight: 50, justifyContent: "center", alignItems: "center" },
  signOutText: { color: palette.muted, fontWeight: "700" },
});

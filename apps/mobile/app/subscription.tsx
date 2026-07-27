import Purchases, { LOG_LEVEL, type PurchasesPackage } from "react-native-purchases";
import { useEffect, useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../src/auth";
import { palette, spacing } from "../src/theme";

export default function SubscriptionScreen(): ReactElement {
  const auth = useAuth();
  const [packages, setPackages] = useState<readonly PurchasesPackage[]>([]);
  const [working, setWorking] = useState(true);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const apiKey = process.env.EXPO_PUBLIC_REVENUECAT_API_KEY;
    if (apiKey === undefined || auth.accessToken === undefined) {
      setFailure("RevenueCat or account configuration is missing");
      setWorking(false);
      return;
    }
    void Purchases.setLogLevel(LOG_LEVEL.WARN);
    Purchases.configure({ apiKey, appUserID: jwtSubject(auth.accessToken) });
    void Purchases.getOfferings()
      .then((offerings) => setPackages(offerings.current?.availablePackages ?? []))
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : "Unable to load products"),
      )
      .finally(() => setWorking(false));
  }, [auth.accessToken]);
  const purchase = async (item: PurchasesPackage): Promise<void> => {
    setWorking(true);
    setFailure(undefined);
    try {
      await Purchases.purchasePackage(item);
      const controlUrl = process.env.EXPO_PUBLIC_CONTROL_URL;
      if (controlUrl !== undefined && auth.accessToken !== undefined)
        await fetch(`${controlUrl}/v1/entitlement/refresh`, {
          method: "POST",
          headers: { authorization: `Bearer ${auth.accessToken}` },
        });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Purchase failed");
    } finally {
      setWorking(false);
    }
  };
  return (
    <SafeAreaView style={styles.shell}>
      <Text style={styles.step}>RELAY PRO / ENTITLEMENT</Text>
      <Text style={styles.title}>Private remote operation, billed through the Store.</Text>
      <Text style={styles.body}>
        Model usage stays on your own provider account. Relay Pro covers encrypted delivery, offline
        queue, push, multiple devices, and attachments.
      </Text>
      {working ? <ActivityIndicator color={palette.signal} /> : null}
      {packages.map((item) => (
        <Pressable
          accessibilityRole="button"
          key={item.identifier}
          style={styles.product}
          onPress={() => {
            void purchase(item);
          }}
        >
          <View>
            <Text style={styles.productTitle}>{item.product.title}</Text>
            <Text style={styles.body}>{item.product.description}</Text>
          </View>
          <Text style={styles.price}>{item.product.priceString}</Text>
        </Pressable>
      ))}
      {failure === undefined ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {failure}
        </Text>
      )}
    </SafeAreaView>
  );
}

function jwtSubject(token: string): string {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("Invalid account token");
  const value: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  if (
    typeof value !== "object" ||
    value === null ||
    !("sub" in value) ||
    typeof value.sub !== "string" ||
    value.sub.length === 0
  )
    throw new Error("Account token has no subject");
  return value.sub;
}
const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: palette.ink, padding: spacing.lg, gap: spacing.lg },
  step: { color: palette.signal, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: palette.paper, fontSize: 34, lineHeight: 40, fontWeight: "300" },
  body: { color: palette.muted, lineHeight: 22 },
  product: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
    padding: spacing.lg,
    gap: spacing.md,
  },
  productTitle: { color: palette.paper, fontSize: 20, fontWeight: "600" },
  price: { color: palette.signal, fontSize: 24, fontWeight: "700" },
  error: { color: palette.danger },
});

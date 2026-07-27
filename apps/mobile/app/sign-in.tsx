import {
  exchangeCodeAsync,
  makeRedirectUri,
  useAuthRequest,
  useAutoDiscovery,
} from "expo-auth-session";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../src/auth";
import { palette, spacing } from "../src/theme";

WebBrowser.maybeCompleteAuthSession();
const issuer = process.env.EXPO_PUBLIC_OIDC_ISSUER;
const clientId = process.env.EXPO_PUBLIC_OIDC_CLIENT_ID;
const redirectUri = makeRedirectUri({ scheme: "pocket-omp", path: "oauth/callback" });

export default function SignInScreen(): ReactElement {
  const auth = useAuth();
  const discovery = useAutoDiscovery(issuer ?? "https://invalid.invalid");
  const [failure, setFailure] = useState<string>();
  const [request, response, promptAsync] = useAuthRequest(
    {
      clientId: clientId ?? "unconfigured",
      scopes: ["openid", "profile", "offline_access"],
      redirectUri,
      usePKCE: true,
    },
    discovery,
  );
  useEffect(() => {
    if (
      response?.type !== "success" ||
      discovery === null ||
      request?.codeVerifier === undefined ||
      clientId === undefined
    )
      return;
    void exchangeCodeAsync(
      {
        clientId,
        code: response.params.code ?? "",
        redirectUri,
        extraParams: { code_verifier: request.codeVerifier },
      },
      discovery,
    )
      .then(async (token) => {
        if (token.accessToken.length < 32)
          throw new Error("Identity provider returned no access token");
        await auth.completeSignIn(token.accessToken);
        router.replace("/");
        return undefined;
      })
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : "Sign in failed"),
      );
  }, [auth, clientId, discovery, request?.codeVerifier, response]);
  const configured = issuer !== undefined && clientId !== undefined;
  return (
    <SafeAreaView style={styles.shell}>
      <View style={styles.card}>
        <Text style={styles.step}>IDENTITY / 01</Text>
        <Text style={styles.title}>Authenticate without sharing provider keys.</Text>
        <Text style={styles.body}>
          Pocket OMP uses authorization code + PKCE. Model-provider credentials remain on your Host.
        </Text>
        {failure === undefined ? null : (
          <Text accessibilityRole="alert" style={styles.error}>
            {failure}
          </Text>
        )}
        {!configured ? (
          <Text accessibilityRole="alert" style={styles.error}>
            Set EXPO_PUBLIC_OIDC_ISSUER and EXPO_PUBLIC_OIDC_CLIENT_ID in the Development Build.
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          testID="continue-oidc-button"
          disabled={!configured || request === null}
          style={[styles.primary, (!configured || request === null) && styles.disabled]}
          onPress={() => {
            setFailure(undefined);
            void promptAsync();
          }}
        >
          {response?.type === "success" ? (
            <ActivityIndicator color={palette.ink} />
          ) : (
            <Text style={styles.primaryText}>CONTINUE TO IDENTITY PROVIDER</Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: palette.ink, padding: spacing.lg, justifyContent: "center" },
  card: {
    backgroundColor: palette.panel,
    borderWidth: 1,
    borderColor: palette.line,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  step: { color: palette.signal, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: palette.paper, fontSize: 32, lineHeight: 38, fontWeight: "300" },
  body: { color: palette.muted, fontSize: 16, lineHeight: 24 },
  error: { color: palette.danger, lineHeight: 20 },
  primary: {
    minHeight: 56,
    backgroundColor: palette.signal,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.md,
  },
  primaryText: { color: palette.ink, fontWeight: "900", fontSize: 12, letterSpacing: 1 },
  disabled: { opacity: 0.35 },
});

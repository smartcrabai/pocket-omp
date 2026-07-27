import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactElement } from "react";
import { AuthProvider } from "../src/auth";
import { palette } from "../src/theme";
import { PushRecovery } from "../src/push-recovery";

export default function RootLayout(): ReactElement {
  return (
    <AuthProvider>
      <PushRecovery />
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.ink },
          headerTintColor: palette.paper,
          contentStyle: { backgroundColor: palette.ink },
          headerShadowVisible: false,
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="sign-in" options={{ title: "Secure sign in", presentation: "modal" }} />
        <Stack.Screen name="pair" options={{ title: "Pair a Host" }} />
        <Stack.Screen name="session/[id]" options={{ title: "Live session" }} />
        <Stack.Screen name="devices" options={{ title: "Devices" }} />
        <Stack.Screen name="subscription" options={{ title: "Relay Pro" }} />
      </Stack>
    </AuthProvider>
  );
}

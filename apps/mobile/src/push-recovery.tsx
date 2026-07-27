import * as Notifications from "expo-notifications";
import { useEffect, type ReactElement } from "react";
import { useAuth } from "./auth";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export function PushRecovery(): ReactElement | null {
  const auth = useAuth();
  useEffect(() => {
    if (auth.accessToken === undefined) return undefined;
    const controlUrl = process.env.EXPO_PUBLIC_CONTROL_URL;
    const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
    if (controlUrl === undefined || projectId === undefined) return undefined;
    let active = true;
    void registerPushToken(controlUrl, projectId, auth.accessToken).catch((error: unknown) => {
      console.warn(
        "Push registration failed",
        error instanceof Error ? error.message : "unknown error",
      );
    });
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      if (!active) return;
      const data = response.notification.request.content.data;
      if (
        data === undefined ||
        typeof data.route_id !== "string" ||
        typeof data.wake_id !== "string"
      )
        return;
      void fetch(`${controlUrl}/v1/relay/wake/${encodeURIComponent(data.wake_id)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ route_id: data.route_id }),
      });
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [auth.accessToken]);
  return null;
}

async function registerPushToken(
  controlUrl: string,
  projectId: string,
  accessToken: string,
): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  const granted = permission.granted ? permission : await Notifications.requestPermissionsAsync();
  if (!granted.granted) return;
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const response = await fetch(`${controlUrl}/v1/push-tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ provider: "expo", token: token.data }),
  });
  if (!response.ok) throw new Error(`Push token registration failed (${response.status})`);
}

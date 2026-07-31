import * as SecureStore from "expo-secure-store";
import {
  isValidDeviceCredential,
  isValidDeviceId,
  routeDeviceCredentialKey,
  routeDeviceIdKey,
} from "./credential-validation";

export interface StoredDeviceCredential {
  readonly deviceId: string;
  readonly deviceCredential: string;
}

// Persists the device identity + bearer credential minted by claimPairing
// alongside a route's pairwise key. Callers are expected to await this inside
// the same Promise.all as the pairwise-key and paired-routes-index writes in
// app/pair.tsx so all pairing state lands together.
export async function saveDeviceCredential(
  routeId: string,
  deviceId: string,
  deviceCredential: string,
): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(routeDeviceIdKey(routeId), deviceId, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
    SecureStore.setItemAsync(routeDeviceCredentialKey(routeId), deviceCredential, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  ]);
}

// Returns undefined when no credential was ever stored for this route (e.g.
// pairing predates this feature, or it was already revoked). Throws when a
// partial or malformed pair is found, since that indicates on-disk
// corruption rather than an absent credential.
export async function loadDeviceCredential(
  routeId: string,
): Promise<StoredDeviceCredential | undefined> {
  const [deviceId, deviceCredential] = await Promise.all([
    SecureStore.getItemAsync(routeDeviceIdKey(routeId)),
    SecureStore.getItemAsync(routeDeviceCredentialKey(routeId)),
  ]);
  if (deviceId === null && deviceCredential === null) return undefined;
  if (
    deviceId === null ||
    deviceCredential === null ||
    !isValidDeviceId(deviceId) ||
    !isValidDeviceCredential(deviceCredential)
  )
    throw new Error("Stored device credential is corrupt");
  return { deviceId, deviceCredential };
}

// Deletes both keys for a route. Safe to call even when nothing was stored
// (expo-secure-store's deleteItemAsync is a no-op for missing keys). Callers
// should invoke this alongside the route.{routeId}.key deletion in the
// devices.tsx revoke flow so no orphaned credential survives revocation.
export async function deleteDeviceCredential(routeId: string): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(routeDeviceIdKey(routeId)),
    SecureStore.deleteItemAsync(routeDeviceCredentialKey(routeId)),
  ]);
}

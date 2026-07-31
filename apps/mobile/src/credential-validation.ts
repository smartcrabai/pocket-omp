// Pure validation and key-derivation logic for device credentials issued by
// `POST /v1/pairings/:id/claim` (see services/control-api/src/control.ts).
//
// This module intentionally imports nothing from expo/react-native so it can
// be exercised directly by `bun test` (native modules such as
// expo-secure-store cannot be loaded outside the Expo runtime).

export const DEVICE_CREDENTIAL_PREFIX = "poc_dev_";

// The Control Plane mints credentials as `poc_dev_` followed by the hex
// encoding of 32 random bytes (see newDeviceCredential in control.ts).
const DEVICE_CREDENTIAL_PATTERN = /^poc_dev_[0-9a-f]{64}$/;

export function isValidDeviceCredential(value: string): boolean {
  return DEVICE_CREDENTIAL_PATTERN.test(value);
}

export function isValidDeviceId(value: string): boolean {
  return value.length > 0;
}

export interface PairingClaim {
  readonly routeId: string;
  readonly deviceId: string;
  readonly deviceCredential: string;
}

// Validates the response body of `POST /v1/pairings/:id/claim`, following the
// same defensive type-guard style already used for `route_id` in app/pair.tsx.
export function parseClaimResponse(value: unknown): PairingClaim {
  if (
    typeof value !== "object" ||
    value === null ||
    !("route_id" in value) ||
    typeof value.route_id !== "string" ||
    value.route_id.length === 0 ||
    !("device_id" in value) ||
    typeof value.device_id !== "string" ||
    !isValidDeviceId(value.device_id) ||
    !("device_credential" in value) ||
    typeof value.device_credential !== "string" ||
    !isValidDeviceCredential(value.device_credential)
  )
    throw new Error("Pairing response is invalid");
  return {
    routeId: value.route_id,
    deviceId: value.device_id,
    deviceCredential: value.device_credential,
  };
}

// SecureStore key naming follows the existing `route.{routeId}.key` /
// `pairing.{pairingId}.secret` convention from app/pair.tsx: the device
// identity minted alongside a route's pairwise key shares that route's
// lifecycle (both are created at claim time and both must be erased together
// on revocation).
export function routeDeviceIdKey(routeId: string): string {
  return `route.${routeId}.device-id`;
}

export function routeDeviceCredentialKey(routeId: string): string {
  return `route.${routeId}.device-credential`;
}

import { describe, expect, test } from "bun:test";
import {
  DEVICE_CREDENTIAL_PREFIX,
  isValidDeviceCredential,
  isValidDeviceId,
  parseClaimResponse,
  routeDeviceCredentialKey,
  routeDeviceIdKey,
} from "../src/credential-validation";

const VALID_CREDENTIAL = `${DEVICE_CREDENTIAL_PREFIX}${"a1".repeat(32)}`;

describe("isValidDeviceCredential", () => {
  test("accepts the poc_dev_ prefix followed by 64 lowercase hex characters", () => {
    expect(isValidDeviceCredential(VALID_CREDENTIAL)).toBeTrue();
  });

  test("rejects a missing prefix", () => {
    expect(isValidDeviceCredential("a1".repeat(32))).toBeFalse();
  });

  test("rejects the wrong prefix", () => {
    expect(isValidDeviceCredential(`poc_host_${"a1".repeat(32)}`)).toBeFalse();
  });

  test("rejects a short payload", () => {
    expect(isValidDeviceCredential(`${DEVICE_CREDENTIAL_PREFIX}a1`)).toBeFalse();
  });

  test("rejects uppercase hex", () => {
    expect(isValidDeviceCredential(`${DEVICE_CREDENTIAL_PREFIX}${"A1".repeat(32)}`)).toBeFalse();
  });

  test("rejects an empty string", () => {
    expect(isValidDeviceCredential("")).toBeFalse();
  });
});

describe("isValidDeviceId", () => {
  test("accepts a non-empty string", () => {
    expect(isValidDeviceId("11111111-1111-1111-1111-111111111111")).toBeTrue();
  });

  test("rejects an empty string", () => {
    expect(isValidDeviceId("")).toBeFalse();
  });
});

describe("parseClaimResponse", () => {
  const valid = {
    route_id: "route-1",
    device_id: "device-1",
    device_credential: VALID_CREDENTIAL,
  };

  test("accepts a well-formed claim response", () => {
    expect(parseClaimResponse(valid)).toEqual({
      routeId: "route-1",
      deviceId: "device-1",
      deviceCredential: VALID_CREDENTIAL,
    });
  });

  test("rejects a non-object body", () => {
    expect(() => parseClaimResponse("not an object")).toThrow();
    expect(() => parseClaimResponse(null)).toThrow();
    expect(() => parseClaimResponse(undefined)).toThrow();
  });

  test("rejects a missing route_id", () => {
    const { route_id: _route_id, ...rest } = valid;
    expect(() => parseClaimResponse(rest)).toThrow();
  });

  test("rejects a missing device_id", () => {
    const { device_id: _device_id, ...rest } = valid;
    expect(() => parseClaimResponse(rest)).toThrow();
  });

  test("rejects a missing device_credential", () => {
    const { device_credential: _device_credential, ...rest } = valid;
    expect(() => parseClaimResponse(rest)).toThrow();
  });

  test("rejects a non-string route_id", () => {
    expect(() => parseClaimResponse({ ...valid, route_id: 1 })).toThrow();
  });

  test("rejects a non-string device_id", () => {
    expect(() => parseClaimResponse({ ...valid, device_id: 1 })).toThrow();
  });

  test("rejects a non-string device_credential", () => {
    expect(() => parseClaimResponse({ ...valid, device_credential: 1 })).toThrow();
  });

  test("rejects an empty route_id", () => {
    expect(() => parseClaimResponse({ ...valid, route_id: "" })).toThrow();
  });

  test("rejects an empty device_id", () => {
    expect(() => parseClaimResponse({ ...valid, device_id: "" })).toThrow();
  });

  test("rejects a malformed device_credential", () => {
    expect(() => parseClaimResponse({ ...valid, device_credential: "not-a-credential" })).toThrow();
  });

  test("never echoes the rejected device_credential value in its error message", () => {
    const marker = "SECRETMARKER0123456789";
    try {
      parseClaimResponse({ ...valid, device_credential: marker });
      throw new Error("expected parseClaimResponse to throw");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(marker);
    }
  });
});

describe("SecureStore key derivation", () => {
  test("derives distinct, route-scoped keys for device id and credential", () => {
    expect(routeDeviceIdKey("route-1")).toBe("route.route-1.device-id");
    expect(routeDeviceCredentialKey("route-1")).toBe("route.route-1.device-credential");
    expect(routeDeviceIdKey("route-1")).not.toBe(routeDeviceCredentialKey("route-1"));
  });
});

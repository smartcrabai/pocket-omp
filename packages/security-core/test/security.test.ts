import { expect, test } from "bun:test";
import {
  MemoryTokenBucketStore,
  SecurityRateLimiter,
  validateSigningKeyRotation,
  type RateLimitPolicy,
  type RateLimitScope,
} from "../src/index";

const policies: Record<RateLimitScope, RateLimitPolicy> = {
  pairing: { capacity: 2, refillPerSecond: 1 },
  auth: { capacity: 2, refillPerSecond: 1 },
  publish: { capacity: 2, refillPerSecond: 1 },
  subscribe: { capacity: 2, refillPerSecond: 1 },
  attachment: { capacity: 2, refillPerSecond: 1 },
  admin: { capacity: 2, refillPerSecond: 1 },
};

test("rate limiter pseudonymizes subjects and refills deterministic buckets", async () => {
  const limiter = new SecurityRateLimiter(
    new MemoryTokenBucketStore(),
    policies,
    new Uint8Array(32).fill(1),
  );
  expect((await limiter.check("auth", "device-1", 1_000n)).allowed).toBeTrue();
  expect((await limiter.check("auth", "device-1", 1_000n)).allowed).toBeTrue();
  const denied = await limiter.check("auth", "device-1", 1_000n);
  expect(denied.allowed).toBeFalse();
  expect(denied.retryAfterMs).toBe(1_000n);
  expect((await limiter.check("auth", "device-1", 2_000n)).allowed).toBeTrue();
  expect((await limiter.check("auth", "device-2", 1_000n)).allowed).toBeTrue();
});

test("signing key rotation retains verification overlap for maximum ticket TTL", () => {
  const keys = [
    { keyId: "old", activatesAtMs: 0n, retiresAtMs: 2_000n },
    { keyId: "new", activatesAtMs: 1_000n, retiresAtMs: 4_000n },
  ];
  const result = validateSigningKeyRotation(keys, 600n, 1_500n);
  expect(result.active.keyId).toBe("new");
  expect(result.verificationKeys.map((key) => key.keyId)).toEqual(["old", "new"]);
  expect(() =>
    validateSigningKeyRotation(
      [
        { keyId: "old", activatesAtMs: 0n, retiresAtMs: 1_500n },
        { keyId: "next", activatesAtMs: 1_000n, retiresAtMs: 3_000n },
      ],
      600n,
      500n,
    ),
  ).toThrow("overlap is shorter");
});

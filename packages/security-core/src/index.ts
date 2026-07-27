export type RateLimitScope = "pairing" | "auth" | "publish" | "subscribe" | "attachment" | "admin";
export interface RateLimitPolicy {
  readonly capacity: number;
  readonly refillPerSecond: number;
}
export interface RateLimitStore {
  consume(
    key: string,
    capacity: number,
    refillPerSecond: number,
    nowMs: bigint,
  ): Promise<{
    readonly allowed: boolean;
    readonly remaining: number;
    readonly retryAfterMs: bigint;
  }>;
}

export class MemoryTokenBucketStore implements RateLimitStore {
  private readonly buckets = new Map<string, { tokens: number; updatedAtMs: bigint }>();
  public async consume(
    key: string,
    capacity: number,
    refillPerSecond: number,
    nowMs: bigint,
  ): Promise<{
    readonly allowed: boolean;
    readonly remaining: number;
    readonly retryAfterMs: bigint;
  }> {
    const previous = this.buckets.get(key) ?? { tokens: capacity, updatedAtMs: nowMs };
    const elapsedMs = Number(nowMs - previous.updatedAtMs);
    const tokens = Math.min(
      capacity,
      previous.tokens + (Math.max(0, elapsedMs) * refillPerSecond) / 1_000,
    );
    const allowed = tokens >= 1;
    const remainingTokens = allowed ? tokens - 1 : tokens;
    this.buckets.set(key, { tokens: remainingTokens, updatedAtMs: nowMs });
    return {
      allowed,
      remaining: Math.floor(remainingTokens),
      retryAfterMs: allowed
        ? 0n
        : BigInt(Math.ceil(((1 - remainingTokens) / refillPerSecond) * 1_000)),
    };
  }
}

export class SecurityRateLimiter {
  public constructor(
    private readonly store: RateLimitStore,
    private readonly policies: Readonly<Record<RateLimitScope, RateLimitPolicy>>,
    private readonly pseudonymKey: Uint8Array,
  ) {
    if (pseudonymKey.byteLength < 32)
      throw new SecurityInvariantError("INVALID_KEY", "Rate-limit pseudonym key is too short");
  }
  public async check(
    scope: RateLimitScope,
    subject: string,
    nowMs: bigint,
  ): Promise<{
    readonly allowed: boolean;
    readonly remaining: number;
    readonly retryAfterMs: bigint;
  }> {
    if (!/^[\x21-\x7e]{1,512}$/.test(subject))
      throw new SecurityInvariantError("INVALID_SUBJECT", "Invalid rate-limit subject");
    const policy = this.policies[scope];
    if (
      !Number.isSafeInteger(policy.capacity) ||
      policy.capacity < 1 ||
      !Number.isFinite(policy.refillPerSecond) ||
      policy.refillPerSecond <= 0
    )
      throw new SecurityInvariantError("INVALID_POLICY", "Invalid rate-limit policy");
    const key = new Bun.CryptoHasher("sha256", this.pseudonymKey)
      .update(`${scope}\0${subject}`)
      .digest("hex");
    return this.store.consume(`${scope}:${key}`, policy.capacity, policy.refillPerSecond, nowMs);
  }
}

export interface SigningKeyMetadata {
  readonly keyId: string;
  readonly activatesAtMs: bigint;
  readonly retiresAtMs: bigint;
}
export function validateSigningKeyRotation(
  keys: readonly SigningKeyMetadata[],
  maximumTicketTtlMs: bigint,
  nowMs: bigint,
): {
  readonly active: SigningKeyMetadata;
  readonly verificationKeys: readonly SigningKeyMetadata[];
} {
  if (maximumTicketTtlMs <= 0n)
    throw new SecurityInvariantError("INVALID_POLICY", "Ticket TTL must be positive");
  const unique = new Set(keys.map((key) => key.keyId));
  if (
    unique.size !== keys.length ||
    keys.some(
      (key) => !/^[\x21-\x7e]{1,128}$/.test(key.keyId) || key.activatesAtMs >= key.retiresAtMs,
    )
  )
    throw new SecurityInvariantError("INVALID_KEY", "Invalid signing key metadata");
  const active = keys
    .filter((key) => key.activatesAtMs <= nowMs && key.retiresAtMs > nowMs)
    .toSorted((left, right) => (left.activatesAtMs > right.activatesAtMs ? -1 : 1))[0];
  if (active === undefined)
    throw new SecurityInvariantError("NO_ACTIVE_KEY", "No active signing key");
  const verificationKeys = keys.filter((key) => key.retiresAtMs > nowMs - maximumTicketTtlMs);
  const next = keys.find((key) => key.activatesAtMs > nowMs);
  if (next !== undefined && active.retiresAtMs < next.activatesAtMs + maximumTicketTtlMs)
    throw new SecurityInvariantError(
      "OVERLAP_TOO_SHORT",
      "Signing key overlap is shorter than maximum ticket TTL",
    );
  return { active, verificationKeys };
}

export class SecurityInvariantError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_KEY"
      | "INVALID_SUBJECT"
      | "INVALID_POLICY"
      | "NO_ACTIVE_KEY"
      | "OVERLAP_TOO_SHORT",
    message: string,
  ) {
    super(message);
    this.name = "SecurityInvariantError";
  }
}

export const CONFIG_SCHEMA_VERSION = 1 as const;

export interface PublicConfig {
  readonly schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  readonly controlOrigin: URL;
  readonly relayTicketAudience: "pocket-omp-relay";
  readonly protocolVersion: 1;
  readonly envelopeMaxBytes: 262_144;
  readonly publishBatchMaxCount: 64;
  readonly publishBatchMaxBytes: 2_097_152;
  readonly messageRetentionMs: 604_800_000;
  readonly pairingTtlMs: 300_000;
  readonly runtimePhysicalFrameMaxBytes: 1_048_576;
  readonly runtimeLogicalMessageMaxBytes: 33_554_432;
}

export function loadPublicConfig(
  environment: Readonly<Record<string, string | undefined>>,
): PublicConfig {
  const controlOrigin = requiredHttpsUrl(
    environment.PUBLIC_CONTROL_ORIGIN,
    "PUBLIC_CONTROL_ORIGIN",
  );
  const schemaVersion = exactInteger(
    environment.CONFIG_SCHEMA_VERSION ?? "1",
    "CONFIG_SCHEMA_VERSION",
  );
  if (schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported CONFIG_SCHEMA_VERSION ${schemaVersion}`);
  }
  return Object.freeze({
    schemaVersion,
    controlOrigin,
    relayTicketAudience: "pocket-omp-relay",
    protocolVersion: 1,
    envelopeMaxBytes: 262_144,
    publishBatchMaxCount: 64,
    publishBatchMaxBytes: 2_097_152,
    messageRetentionMs: 604_800_000,
    pairingTtlMs: 300_000,
    runtimePhysicalFrameMaxBytes: 1_048_576,
    runtimeLogicalMessageMaxBytes: 33_554_432,
  });
}

function requiredHttpsUrl(value: string | undefined, name: string): URL {
  if (value === undefined) throw new ConfigError(`${name} is required`);
  const parsed = URL.parse(value);
  if (
    parsed === null ||
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new ConfigError(`${name} must be an HTTPS origin`);
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new ConfigError(`${name} must not contain a path, query, or fragment`);
  }
  return parsed;
}

function exactInteger(value: string, name: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new ConfigError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ConfigError(`${name} is outside the safe range`);
  return parsed;
}

export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

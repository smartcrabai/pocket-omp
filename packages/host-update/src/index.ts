import { signDeviceStatement, verifyDeviceStatement } from "@pocket-omp/crypto";

export const HOST_UPDATE_MANIFEST_VERSION = 1;
export const HOST_RELEASE_UNITS = [
  "pocket-omp-host",
  "pocket-omp-agent-runtime",
  "pocket-omp",
  "omp",
] as const;

export interface HostArtifact {
  readonly unit: (typeof HOST_RELEASE_UNITS)[number];
  readonly platform: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: bigint;
}

export interface HostUpdateManifest {
  readonly manifestVersion: number;
  readonly releaseVersion: string;
  readonly ompSdkVersion: string;
  readonly tuiVersion: string;
  readonly runtimeIpcMinimum: number;
  readonly runtimeIpcMaximum: number;
  readonly generatedAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly artifacts: readonly HostArtifact[];
}

export function canonicalHostUpdateManifest(manifest: HostUpdateManifest): Uint8Array {
  validateManifest(manifest);
  const artifacts = [...manifest.artifacts].toSorted((left, right) =>
    left.unit.localeCompare(right.unit),
  );
  const fields: Uint8Array[] = [
    text("pocket-omp/host-update-manifest/v1"),
    u32(manifest.manifestVersion),
    text(manifest.releaseVersion),
    text(manifest.ompSdkVersion),
    text(manifest.tuiVersion),
    u32(manifest.runtimeIpcMinimum),
    u32(manifest.runtimeIpcMaximum),
    i64(manifest.generatedAtMs),
    i64(manifest.expiresAtMs),
  ];
  for (const artifact of artifacts) {
    fields.push(
      text(artifact.unit),
      text(artifact.platform),
      text(artifact.url),
      text(artifact.sha256),
      u64(artifact.size),
    );
  }
  return tuple(fields);
}

export function signHostUpdateManifest(
  secretKey: Uint8Array,
  manifest: HostUpdateManifest,
): Uint8Array {
  return signDeviceStatement(secretKey, canonicalHostUpdateManifest(manifest));
}

export function verifyHostUpdateManifest(input: {
  readonly publicKey: Uint8Array;
  readonly manifest: HostUpdateManifest;
  readonly signature: Uint8Array;
  readonly nowMs: bigint;
  readonly currentVersion: string;
  readonly runtimeIpcVersion: number;
}): void {
  const { manifest } = input;
  const statement = canonicalHostUpdateManifest(manifest);
  if (!verifyDeviceStatement(input.publicKey, statement, input.signature)) {
    throw new HostUpdateError("INVALID_SIGNATURE", "Host update manifest signature is invalid");
  }
  if (input.nowMs > manifest.expiresAtMs || input.nowMs < manifest.generatedAtMs) {
    throw new HostUpdateError("EXPIRED", "Host update manifest is outside its validity window");
  }
  if (compareSemver(manifest.releaseVersion, input.currentVersion) <= 0) {
    throw new HostUpdateError("DOWNGRADE", "Host update does not advance the installed version");
  }
  if (
    input.runtimeIpcVersion < manifest.runtimeIpcMinimum ||
    input.runtimeIpcVersion > manifest.runtimeIpcMaximum
  ) {
    throw new HostUpdateError("IPC_INCOMPATIBLE", "Host update runtime IPC range is incompatible");
  }
}

export function verifyHostArtifact(artifact: HostArtifact, bytes: Uint8Array): void {
  verifyHostArtifactDigest(artifact, {
    size: BigInt(bytes.byteLength),
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  });
}

export function verifyHostArtifactDigest(
  artifact: HostArtifact,
  actual: { readonly size: bigint; readonly sha256: string },
): void {
  if (actual.size !== artifact.size)
    throw new HostUpdateError("ARTIFACT_SIZE", "Host artifact size mismatch");
  if (actual.sha256 !== artifact.sha256)
    throw new HostUpdateError("ARTIFACT_HASH", "Host artifact checksum mismatch");
}

function validateManifest(manifest: HostUpdateManifest): void {
  if (manifest.manifestVersion !== HOST_UPDATE_MANIFEST_VERSION)
    throw new HostUpdateError("INVALID_MANIFEST", "Unsupported Host update manifest");
  if (
    manifest.generatedAtMs > manifest.expiresAtMs ||
    manifest.runtimeIpcMinimum > manifest.runtimeIpcMaximum
  )
    throw new HostUpdateError("INVALID_MANIFEST", "Invalid Host update bounds");
  const units = new Set(manifest.artifacts.map((artifact) => artifact.unit));
  if (
    manifest.artifacts.length !== HOST_RELEASE_UNITS.length ||
    HOST_RELEASE_UNITS.some((unit) => !units.has(unit))
  )
    throw new HostUpdateError(
      "PARTIAL_RELEASE",
      "Host update must contain the complete atomic release set",
    );
  for (const artifact of manifest.artifacts) {
    if (
      !artifact.url.startsWith("https://") ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      artifact.size <= 0n
    )
      throw new HostUpdateError("INVALID_MANIFEST", "Invalid Host artifact metadata");
  }
  for (const version of [manifest.releaseVersion, manifest.ompSdkVersion, manifest.tuiVersion])
    parseSemver(version);
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseSemver(value: string): readonly number[] {
  if (!/^\d+\.\d+\.\d+$/.test(value))
    throw new HostUpdateError("INVALID_MANIFEST", "Invalid semantic version");
  return value.split(".").map(Number);
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const u32 = (value: number): Uint8Array => {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, false);
  return result;
};
const u64 = (value: bigint): Uint8Array => {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, false);
  return result;
};
const i64 = (value: bigint): Uint8Array => {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigInt64(0, value, false);
  return result;
};
function tuple(fields: readonly Uint8Array[]): Uint8Array {
  const length = fields.reduce((sum, field) => sum + 4 + field.byteLength, 0);
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength, false);
    offset += 4;
    result.set(field, offset);
    offset += field.byteLength;
  }
  return result;
}

export class HostUpdateError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_MANIFEST"
      | "PARTIAL_RELEASE"
      | "INVALID_SIGNATURE"
      | "EXPIRED"
      | "DOWNGRADE"
      | "IPC_INCOMPATIBLE"
      | "ARTIFACT_SIZE"
      | "ARTIFACT_HASH",
    message: string,
  ) {
    super(message);
    this.name = "HostUpdateError";
  }
}

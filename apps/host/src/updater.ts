import { chmod, copyFile, mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  HOST_RELEASE_UNITS,
  verifyHostArtifactDigest,
  verifyHostUpdateManifest,
  type HostArtifact,
  type HostUpdateManifest,
} from "@pocket-omp/host-update";

import { localControlPaths } from "./local-control";
import { RELEASE_VERSION } from "./shared";
import { HOST_UPDATE_SIGNING_PUBLIC_KEY_BASE64 } from "./update-trust";

const RUNTIME_IPC_VERSION = 1;
const UPDATE_MARKER = ".pocket-omp-update.json";

export interface PreparedHostUpdate {
  readonly stagingDirectory: string;
  readonly installDirectory: string;
  readonly platform: string;
  readonly manifest: HostUpdateManifest;
}

export interface HostUpdateOptions {
  readonly manifestUrl?: string;
  readonly installDirectory?: string;
  readonly platform?: string;
  readonly currentVersion?: string;
  readonly nowMs?: bigint;
  readonly fetcher?: typeof fetch;
  readonly publicKey?: Uint8Array;
}

interface SerializedHostUpdateManifest {
  readonly manifestVersion: number;
  readonly releaseVersion: string;
  readonly ompSdkVersion: string;
  readonly tuiVersion: string;
  readonly runtimeIpcMinimum: number;
  readonly runtimeIpcMaximum: number;
  readonly generatedAtMs: string;
  readonly expiresAtMs: string;
  readonly artifacts: readonly {
    readonly unit: string;
    readonly platform: string;
    readonly url: string;
    readonly sha256: string;
    readonly size: string;
  }[];
  readonly signature: string;
}

export async function prepareHostUpdate(
  options: HostUpdateOptions = {},
): Promise<PreparedHostUpdate> {
  const platform = options.platform ?? currentHostPlatform();
  const installDirectory = options.installDirectory ?? dirname(process.execPath);
  const manifestUrl =
    options.manifestUrl ??
    `https://github.com/smartcrabai/pocket-omp/releases/latest/download/host-update-${platform}.json`;
  if (!manifestUrl.startsWith("https://"))
    throw new HostUpdaterError("MANIFEST_URL", "Manifest URL must use HTTPS");
  if (await Bun.file(localControlPaths().secretPath).exists()) {
    throw new HostUpdaterError("HOST_RUNNING", "Stop Pocket OMP Host before applying an update");
  }
  const response = await (options.fetcher ?? fetch)(manifestUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new HostUpdaterError(
      "MANIFEST_FETCH",
      `Unable to fetch Host update manifest: ${response.status}`,
    );
  }
  const serialized = parseSerializedManifest(await response.json());
  const manifest = deserializeManifest(serialized);
  const signature = decodeBase64(serialized.signature, 64, "manifest signature");
  verifyHostUpdateManifest({
    manifest,
    signature,
    publicKey: options.publicKey ?? trustedPublicKey(),
    nowMs: options.nowMs ?? BigInt(Date.now()),
    currentVersion: options.currentVersion ?? RELEASE_VERSION,
    runtimeIpcVersion: RUNTIME_IPC_VERSION,
  });
  if (manifest.artifacts.some((artifact) => artifact.platform !== platform)) {
    throw new HostUpdaterError(
      "PLATFORM",
      "Host update manifest platform does not match this Host",
    );
  }
  await mkdir(dirname(installDirectory), { recursive: true });
  const stagingDirectory = await mkdtemp(join(dirname(installDirectory), ".pocket-omp-update-"));
  try {
    await Promise.all(
      manifest.artifacts.map(async (artifact) => {
        const outputPath = join(stagingDirectory, releaseFileName(artifact.unit, platform));
        await downloadArtifact(artifact, outputPath, options.fetcher ?? fetch);
        if (process.platform !== "win32") await chmod(outputPath, 0o755);
      }),
    );
    await Bun.write(join(stagingDirectory, UPDATE_MARKER), `${JSON.stringify(serialized)}\n`);
    return { stagingDirectory, installDirectory, platform, manifest };
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function applyPreparedHostUpdate(
  prepared: PreparedHostUpdate,
  options: Pick<HostUpdateOptions, "currentVersion" | "nowMs" | "publicKey"> = {},
): Promise<void> {
  const marker = parseSerializedManifest(
    await Bun.file(join(prepared.stagingDirectory, UPDATE_MARKER)).json(),
  );
  const manifest = deserializeManifest(marker);
  verifyHostUpdateManifest({
    manifest,
    signature: decodeBase64(marker.signature, 64, "manifest signature"),
    publicKey: options.publicKey ?? trustedPublicKey(),
    nowMs: options.nowMs ?? BigInt(Date.now()),
    currentVersion: options.currentVersion ?? RELEASE_VERSION,
    runtimeIpcVersion: RUNTIME_IPC_VERSION,
  });
  if (
    manifest.releaseVersion !== prepared.manifest.releaseVersion ||
    manifest.artifacts.some((artifact) => artifact.platform !== prepared.platform)
  ) {
    throw new HostUpdaterError("PREPARED_SET", "Prepared Host update metadata changed");
  }
  await verifyPreparedArtifacts(prepared.stagingDirectory, prepared.platform, manifest.artifacts);
  await applyTransaction(prepared.stagingDirectory, prepared.installDirectory, prepared.platform);
}

export async function runHostUpdate(args: readonly string[]): Promise<number> {
  const manifestUrl = option(args, "--manifest-url");
  const installDirectory = option(args, "--install-dir");
  const prepared = await prepareHostUpdate({
    ...(manifestUrl === undefined ? {} : { manifestUrl }),
    ...(installDirectory === undefined ? {} : { installDirectory }),
  });
  if (process.platform !== "win32") {
    await applyPreparedHostUpdate(prepared);
    await Bun.write(Bun.stdout, `Pocket OMP updated to ${prepared.manifest.releaseVersion}\n`);
    return 0;
  }
  const helperDirectory = await mkdtemp(join(tmpdir(), "pocket-omp-updater-"));
  const helperPath = join(helperDirectory, "pocket-omp-updater.exe");
  await copyFile(
    join(prepared.stagingDirectory, releaseFileName("pocket-omp", prepared.platform)),
    helperPath,
  );
  const child = Bun.spawn(
    [
      helperPath,
      "__apply-update",
      prepared.stagingDirectory,
      prepared.installDirectory,
      String(process.pid),
      RELEASE_VERSION,
      helperDirectory,
    ],
    { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
  );
  child.unref();
  await Bun.write(
    Bun.stdout,
    `Pocket OMP ${prepared.manifest.releaseVersion} update scheduled; restart after this process exits\n`,
  );
  return 0;
}

export async function runPreparedUpdateHelper(args: readonly string[]): Promise<number> {
  const [stagingDirectory, installDirectory, parentPidValue, currentVersion, helperDirectory] =
    args;
  if (
    stagingDirectory === undefined ||
    installDirectory === undefined ||
    parentPidValue === undefined ||
    currentVersion === undefined ||
    helperDirectory === undefined
  ) {
    throw new HostUpdaterError("HELPER_ARGS", "Update helper arguments are incomplete");
  }
  await waitForProcessExit(Number(parentPidValue));
  const marker = parseSerializedManifest(
    await Bun.file(join(stagingDirectory, UPDATE_MARKER)).json(),
  );
  const manifest = deserializeManifest(marker);
  const platform = currentHostPlatform();
  await applyPreparedHostUpdate(
    { stagingDirectory, installDirectory, platform, manifest },
    { currentVersion },
  );
  const installedCli = join(installDirectory, releaseFileName("pocket-omp", platform));
  const cleanup = Bun.spawn(
    [installedCli, "__cleanup-update-helper", helperDirectory, String(process.pid)],
    { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
  );
  cleanup.unref();
  return 0;
}

export async function runUpdateHelperCleanup(args: readonly string[]): Promise<number> {
  const [helperDirectory, helperPidValue] = args;
  if (helperDirectory === undefined || helperPidValue === undefined) return 2;
  await waitForProcessExit(Number(helperPidValue));
  await rm(helperDirectory, { recursive: true, force: true });
  return 0;
}

export function currentHostPlatform(): string {
  return `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

async function downloadArtifact(
  artifact: HostArtifact,
  outputPath: string,
  fetcher: typeof fetch,
): Promise<void> {
  const response = await fetcher(artifact.url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new HostUpdaterError(
      "ARTIFACT_FETCH",
      `Unable to fetch ${artifact.unit}: ${response.status}`,
    );
  }
  const writer = Bun.file(outputPath).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let size = 0n;
  try {
    for await (const chunk of response.body) {
      size += BigInt(chunk.byteLength);
      if (size > artifact.size)
        throw new HostUpdaterError("ARTIFACT_SIZE", `${artifact.unit} exceeds signed size`);
      hasher.update(chunk);
      await writer.write(chunk);
    }
  } finally {
    await writer.end();
  }
  verifyHostArtifactDigest(artifact, { size, sha256: hasher.digest("hex") });
}

async function verifyPreparedArtifacts(
  stagingDirectory: string,
  platform: string,
  artifacts: readonly HostArtifact[],
): Promise<void> {
  await Promise.all(
    artifacts.map(async (artifact) => {
      const path = join(stagingDirectory, releaseFileName(artifact.unit, platform));
      const hasher = new Bun.CryptoHasher("sha256");
      let size = 0n;
      for await (const chunk of Bun.file(path).stream()) {
        size += BigInt(chunk.byteLength);
        hasher.update(chunk);
      }
      verifyHostArtifactDigest(artifact, { size, sha256: hasher.digest("hex") });
    }),
  );
}

async function applyTransaction(
  stagingDirectory: string,
  installDirectory: string,
  platform: string,
): Promise<void> {
  await mkdir(installDirectory, { recursive: true });
  const parentDirectory = dirname(installDirectory);
  const lockPath = join(parentDirectory, ".pocket-omp-update.lock");
  const lock = await open(lockPath, "wx", 0o600).catch((error: unknown) => {
    throw new HostUpdaterError("UPDATE_LOCK", "Another Host update is in progress", {
      cause: error,
    });
  });
  let backupDirectory: string | undefined;
  try {
    backupDirectory = await mkdtemp(join(parentDirectory, ".pocket-omp-backup-"));
    const installed: string[] = [];
    const backedUp: string[] = [];
    try {
      for (const unit of HOST_RELEASE_UNITS) {
        const name = releaseFileName(unit, platform);
        const target = join(installDirectory, name);
        // oxlint-disable-next-line no-await-in-loop -- The rollback journal follows move order.
        await stat(target);
        // oxlint-disable-next-line no-await-in-loop -- Release files must leave service together.
        await rename(target, join(backupDirectory, name));
        backedUp.push(name);
      }
      for (const unit of HOST_RELEASE_UNITS) {
        const name = releaseFileName(unit, platform);
        // oxlint-disable-next-line no-await-in-loop -- The install journal follows move order.
        await rename(join(stagingDirectory, name), join(installDirectory, name));
        installed.push(name);
      }
    } catch (error) {
      await Promise.all(installed.map((name) => rm(join(installDirectory, name), { force: true })));
      for (const name of backedUp.toReversed()) {
        // oxlint-disable-next-line no-await-in-loop -- Rollback must restore reverse move order.
        await rename(join(backupDirectory, name), join(installDirectory, name));
      }
      await rm(backupDirectory, { recursive: true, force: true });
      backupDirectory = undefined;
      throw new HostUpdaterError("APPLY", "Host update transaction rolled back", { cause: error });
    }
    await rm(backupDirectory, { recursive: true, force: true });
    backupDirectory = undefined;
    await rm(stagingDirectory, { recursive: true, force: true });
  } finally {
    if (backupDirectory !== undefined) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function parseSerializedManifest(value: unknown): SerializedHostUpdateManifest {
  const object = requireObject(value, "Host update manifest");
  const artifacts = Reflect.get(object, "artifacts");
  if (!Array.isArray(artifacts))
    throw new HostUpdaterError("MANIFEST", "Manifest artifacts are invalid");
  return {
    manifestVersion: numberField(object, "manifestVersion"),
    releaseVersion: stringField(object, "releaseVersion"),
    ompSdkVersion: stringField(object, "ompSdkVersion"),
    tuiVersion: stringField(object, "tuiVersion"),
    runtimeIpcMinimum: numberField(object, "runtimeIpcMinimum"),
    runtimeIpcMaximum: numberField(object, "runtimeIpcMaximum"),
    generatedAtMs: stringField(object, "generatedAtMs"),
    expiresAtMs: stringField(object, "expiresAtMs"),
    artifacts: artifacts.map((artifact) => {
      const item = requireObject(artifact, "Host artifact");
      return {
        unit: stringField(item, "unit"),
        platform: stringField(item, "platform"),
        url: stringField(item, "url"),
        sha256: stringField(item, "sha256"),
        size: stringField(item, "size"),
      };
    }),
    signature: stringField(object, "signature"),
  };
}

function deserializeManifest(value: SerializedHostUpdateManifest): HostUpdateManifest {
  return {
    manifestVersion: value.manifestVersion,
    releaseVersion: value.releaseVersion,
    ompSdkVersion: value.ompSdkVersion,
    tuiVersion: value.tuiVersion,
    runtimeIpcMinimum: value.runtimeIpcMinimum,
    runtimeIpcMaximum: value.runtimeIpcMaximum,
    generatedAtMs: parseInteger(value.generatedAtMs, "generatedAtMs"),
    expiresAtMs: parseInteger(value.expiresAtMs, "expiresAtMs"),
    artifacts: value.artifacts.map((artifact) => {
      if (!isHostReleaseUnit(artifact.unit)) {
        throw new HostUpdaterError("MANIFEST", `Unknown Host artifact unit ${artifact.unit}`);
      }
      return {
        unit: artifact.unit,
        platform: artifact.platform,
        url: artifact.url,
        sha256: artifact.sha256,
        size: parseInteger(artifact.size, "artifact size"),
      };
    }),
  };
}
function isHostReleaseUnit(value: string): value is HostArtifact["unit"] {
  return (
    value === "pocket-omp-host" ||
    value === "pocket-omp-agent-runtime" ||
    value === "pocket-omp" ||
    value === "omp"
  );
}

function trustedPublicKey(): Uint8Array {
  return decodeBase64(HOST_UPDATE_SIGNING_PUBLIC_KEY_BASE64, 32, "trusted public key");
}

function decodeBase64(value: string, length: number, label: string): Uint8Array {
  const decoded = Uint8Array.from(Buffer.from(value, "base64"));
  if (decoded.byteLength !== length || Buffer.from(decoded).toString("base64") !== value) {
    throw new HostUpdaterError("BASE64", `Invalid ${label}`);
  }
  return decoded;
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostUpdaterError("MANIFEST", `${label} is invalid`);
  }
  return value;
}

function stringField(value: object, name: string): string {
  const field = Reflect.get(value, name);
  if (typeof field !== "string") throw new HostUpdaterError("MANIFEST", `${name} is invalid`);
  return field;
}

function numberField(value: object, name: string): number {
  const field = Reflect.get(value, name);
  if (!Number.isSafeInteger(field)) throw new HostUpdaterError("MANIFEST", `${name} is invalid`);
  return field;
}

function parseInteger(value: string, name: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new HostUpdaterError("MANIFEST", `${name} is invalid`);
  return BigInt(value);
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.length === 0)
    throw new HostUpdaterError("ARGUMENT", `${name} requires a value`);
  return value;
}

function releaseFileName(unit: string, platform: string): string {
  return platform.startsWith("windows-") ? `${unit}-${platform}.exe` : `${unit}-${platform}`;
}

async function waitForProcessExit(pid: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new HostUpdaterError("PID", "Invalid update helper PID");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- Process liveness requires bounded polling.
    await Bun.sleep(50);
  }
  throw new HostUpdaterError("PARENT_TIMEOUT", "Timed out waiting for update process to exit");
}

export class HostUpdaterError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostUpdaterError";
  }
}

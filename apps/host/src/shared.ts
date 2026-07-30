import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import manifest from "../package.json" with { type: "json" };

const injectedVersion =
  typeof POCKET_OMP_BUILD_VERSION === "string" ? POCKET_OMP_BUILD_VERSION : undefined;
const injectedOmpVersion =
  typeof POCKET_OMP_OMP_VERSION === "string" ? POCKET_OMP_OMP_VERSION : undefined;

export const RELEASE_VERSION = injectedVersion ?? manifest.version;
export const OMP_VERSION = injectedOmpVersion ?? "17.1.5";
export const ARTIFACT_KIND = "atomic-host-release";

export function formatVersion(unit: string, json: boolean): string {
  const value = {
    unit,
    version: unit === "omp" ? OMP_VERSION : RELEASE_VERSION,
    releaseVersion: RELEASE_VERSION,
    artifactKind: ARTIFACT_KIND,
    releaseReady: true,
  };
  return json ? `${JSON.stringify(value)}\n` : `${unit} ${value.version}\n`;
}

export function companionPath(unit: string): string {
  const baseDirectory = process.env.POCKET_OMP_BIN_DIR ?? dirname(process.execPath);
  const executable = process.platform === "win32" ? `${unit}.exe` : unit;
  const installedPath = join(baseDirectory, executable);
  if (existsSync(installedPath)) return installedPath;
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const releaseName =
    process.platform === "win32" ? `${unit}-${platform}.exe` : `${unit}-${platform}`;
  const releasePath = join(baseDirectory, releaseName);
  return existsSync(releasePath) ? releasePath : installedPath;
}

export async function runCompanion(unit: string, args: readonly string[]): Promise<number> {
  const executable = companionPath(unit);
  const child = Bun.spawn([executable, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const forward = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // The child may have exited between signal delivery and forwarding.
    }
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
  }
}

export function isVersionRequest(args: readonly string[]): boolean {
  return args[0] === "--version" || args[0] === "version";
}

export function wantsJson(args: readonly string[]): boolean {
  return args.includes("--json");
}

declare const POCKET_OMP_BUILD_VERSION: string;
declare const POCKET_OMP_OMP_VERSION: string;

import { access } from "node:fs/promises";

import { ARTIFACT_KIND, companionPath, OMP_VERSION, RELEASE_VERSION } from "./shared";

export interface CompanionInspection {
  readonly unit: string;
  readonly path: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ReleaseInspection {
  readonly artifactKind: typeof ARTIFACT_KIND;
  readonly releaseReady: boolean;
  readonly ok: boolean;
  readonly releaseVersion: string;
  readonly results: readonly CompanionInspection[];
}

export interface CompanionProbeResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type CompanionProbe = (unit: string, path: string) => Promise<CompanionProbeResult>;

export async function inspectAtomicRelease(
  probe: CompanionProbe = probeCompanion,
): Promise<ReleaseInspection> {
  const expected: Readonly<Record<string, string>> = {
    "pocket-omp-host": RELEASE_VERSION,
    "pocket-omp-agent-runtime": RELEASE_VERSION,
    omp: OMP_VERSION,
  };
  const results = await Promise.all(
    Object.entries(expected).map(async ([unit, expectedVersion]) => {
      const path = companionPath(unit);
      try {
        const { stdout, stderr, exitCode } = await probe(unit, path);
        if (exitCode !== 0) {
          return { unit, path, ok: false, detail: stderr.trim() || `exit ${exitCode}` };
        }
        const value: unknown = unit === "omp" ? undefined : JSON.parse(stdout);
        const actualVersion =
          unit === "omp" ? /^omp\/(.+)\s*$/.exec(stdout)?.[1] : readString(value, "version");
        const releaseVersion =
          unit === "omp" ? RELEASE_VERSION : readString(value, "releaseVersion");
        const ready = unit === "omp" ? true : readBoolean(value, "releaseReady");
        const ok =
          actualVersion === expectedVersion && releaseVersion === RELEASE_VERSION && ready === true;
        return {
          unit,
          path,
          ok,
          detail: ok
            ? "compatible"
            : `expected ${expectedVersion} in release ${RELEASE_VERSION}, got ${actualVersion} in ${releaseVersion}`,
        };
      } catch (error) {
        return {
          unit,
          path,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const ok = results.every((result) => result.ok);
  return {
    artifactKind: ARTIFACT_KIND,
    releaseReady: ok,
    ok,
    releaseVersion: RELEASE_VERSION,
    results,
  };
}

async function probeCompanion(unit: string, path: string): Promise<CompanionProbeResult> {
  await access(path);
  const child = Bun.spawn([path, "--version", ...(unit === "omp" ? [] : ["--json"])], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(child.stdout),
    Bun.readableStreamToText(child.stderr),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const member = Reflect.get(value, key);
  return typeof member === "string" ? member : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const member = Reflect.get(value, key);
  return typeof member === "boolean" ? member : undefined;
}

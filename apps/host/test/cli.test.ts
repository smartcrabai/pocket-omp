import { describe, expect, test } from "bun:test";
import { basename, dirname, extname } from "node:path";

import { inspectAtomicRelease, type CompanionProbe } from "../src/doctor";
import {
  formatVersion,
  isVersionRequest,
  RELEASE_VERSION,
  runCompanion,
  wantsJson,
} from "../src/shared";

describe("Pocket OMP CLI", () => {
  test("pins the Host release version", () => {
    expect(RELEASE_VERSION).toBe("1.0.0");
  });

  test("formats human and machine-readable versions", () => {
    expect(formatVersion("pocket-omp", false)).toBe("pocket-omp 1.0.0\n");
    expect(JSON.parse(formatVersion("pocket-omp", true))).toEqual({
      unit: "pocket-omp",
      version: "1.0.0",
      releaseVersion: "1.0.0",
      artifactKind: "atomic-host-release",
      releaseReady: true,
    });
  });

  test("recognizes version and JSON flags", () => {
    expect(isVersionRequest(["version"])).toBe(true);
    expect(isVersionRequest(["--version"])).toBe(true);
    expect(isVersionRequest(["doctor"])).toBe(false);
    expect(wantsJson(["doctor", "--json"])).toBe(true);
  });

  test("runs an installed companion and returns its exit code", async () => {
    const previous = process.env.POCKET_OMP_BIN_DIR;
    process.env.POCKET_OMP_BIN_DIR = dirname(process.execPath);
    try {
      const unit = basename(process.execPath, extname(process.execPath));
      expect(await runCompanion(unit, ["--version"])).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.POCKET_OMP_BIN_DIR;
      else process.env.POCKET_OMP_BIN_DIR = previous;
    }
  });

  test("rejects an incomplete or skewed atomic release", async () => {
    const inspection = await inspectAtomicRelease(probeFor("1.0.1"));
    expect(inspection.ok).toBe(false);
    expect(inspection.results).toContainEqual(
      expect.objectContaining({ unit: "pocket-omp-agent-runtime", ok: false }),
    );
  });

  test("reports nonzero companion exits", async () => {
    const inspection = await inspectAtomicRelease(async () => ({
      stdout: "",
      stderr: "failed",
      exitCode: 2,
    }));
    expect(inspection.ok).toBe(false);
    expect(inspection.results[0]?.detail).toBe("failed");
  });

  test("reports companion probe failures without aborting inspection", async () => {
    const inspection = await inspectAtomicRelease(async () => {
      throw new Error("unavailable");
    });
    expect(inspection.ok).toBe(false);
    expect(inspection.results).toHaveLength(3);
    expect(inspection.results[0]?.detail).toBe("unavailable");
  });

  test("accepts a complete version-aligned atomic release", async () => {
    const inspection = await inspectAtomicRelease(probeFor("1.0.0"));
    expect(inspection).toEqual(
      expect.objectContaining({
        ok: true,
        releaseReady: true,
        releaseVersion: "1.0.0",
      }),
    );
  });
});

function probeFor(runtimeVersion: string): CompanionProbe {
  return async (unit) => {
    const version = unit === "pocket-omp-agent-runtime" ? runtimeVersion : "1.0.0";
    const stdout =
      unit === "omp"
        ? "omp/17.1.5\n"
        : `${JSON.stringify({ unit, version, releaseVersion: version, releaseReady: true })}\n`;
    return { stdout, stderr: "", exitCode: 0 };
  };
}

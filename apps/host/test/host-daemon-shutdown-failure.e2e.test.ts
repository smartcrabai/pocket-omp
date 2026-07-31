import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

interface SmokeResult {
  readonly ok: boolean;
  readonly elapsedMs: number;
}

function parseSmokeResult(json: string): SmokeResult {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) throw new Error("Expected a JSON object");
  const ok = Reflect.get(value, "ok");
  const elapsedMs = Reflect.get(value, "elapsedMs");
  if (typeof ok !== "boolean" || typeof elapsedMs !== "number") {
    throw new Error("Malformed smoke result");
  }
  return { ok, elapsedMs };
}

describe("Host Daemon close() catch-block fallback end-to-end", () => {
  test("close() resolves (does not hang or throw) when Runtime never answers shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocket-omp-daemon-shutdown-failure-e2e-"));
    directories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const resultPath = join(directory, "result.json");
    await writeFile(sessionPath, '{"type":"session"}\n');
    const bunExecutable = Bun.which("bun");
    if (bunExecutable === null) throw new Error("Bun executable not found");
    const child = Bun.spawn(
      [
        bunExecutable,
        resolve("apps/host/test/fixtures/daemon-shutdown-failure-smoke.ts"),
        directory,
        sessionPath,
        resultPath,
      ],
      { cwd: resolve("."), stdout: "ignore", stderr: "pipe" },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const result = parseSmokeResult(await readFile(resultPath, "utf8"));
    expect(result.ok).toBe(true);
    // shutdownRuntime's snapshot wait uses RuntimeFrameRouter's default 10s
    // timeout; close() must wait it out (proving the failure path actually
    // ran) but must not hang well beyond it (proving the fallback --
    // disposing the process and stopping the router -- actually completes).
    expect(result.elapsedMs).toBeGreaterThanOrEqual(9_000);
    expect(result.elapsedMs).toBeLessThan(20_000);
  }, 30_000);
});

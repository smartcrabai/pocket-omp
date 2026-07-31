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
  readonly code: string;
  readonly message: string;
}

function parseSmokeResult(json: string): SmokeResult {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) throw new Error("Expected a JSON object");
  const ok = Reflect.get(value, "ok");
  const code = Reflect.get(value, "code");
  const message = Reflect.get(value, "message");
  if (typeof ok !== "boolean" || typeof code !== "string" || typeof message !== "string") {
    throw new Error("Malformed smoke result");
  }
  return { ok, code, message };
}

async function runFixture(
  directory: string,
  sessionPath: string,
  resultPath: string,
  mode: "no-hello" | "bad-hello",
): Promise<SmokeResult> {
  const bunExecutable = Bun.which("bun");
  if (bunExecutable === null) throw new Error("Bun executable not found");
  const child = Bun.spawn(
    [
      bunExecutable,
      resolve("apps/host/test/fixtures/daemon-handshake-failure-smoke.ts"),
      directory,
      sessionPath,
      resultPath,
      mode,
    ],
    { cwd: resolve("."), stdout: "ignore", stderr: "pipe" },
  );
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return parseSmokeResult(await readFile(resultPath, "utf8"));
}

describe("Host Daemon startRuntime handshake failure paths end-to-end", () => {
  test("hello-wait-timeout: startRuntime rejects with HostDaemonError(RUNTIME) reporting the timeout, and does not hang", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocket-omp-daemon-hello-timeout-e2e-"));
    directories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const resultPath = join(directory, "result.json");
    await writeFile(sessionPath, '{"type":"session"}\n');

    const result = await runFixture(directory, sessionPath, resultPath, "no-hello");
    expect(result.ok).toBe(true);
    // startRuntime's hello-wait catch block always rethrows as "RUNTIME"
    // (it wraps RuntimeFrameRouter's underlying TIMEOUT together with the
    // process's exit status/stderr, rather than surfacing "TIMEOUT" itself
    // -- unlike the ready-wait failure path, which goes through nextFrame's
    // generic TIMEOUT mapping).
    expect(result.code).toBe("RUNTIME");
    expect(result.message).toContain("Timed out waiting for Runtime hello");
  }, 25_000);

  test("protocol-version-mismatch: startRuntime rejects with HostDaemonError(PROTOCOL)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocket-omp-daemon-protocol-mismatch-e2e-"));
    directories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const resultPath = join(directory, "result.json");
    await writeFile(sessionPath, '{"type":"session"}\n');

    const result = await runFixture(directory, sessionPath, resultPath, "bad-hello");
    expect(result.ok).toBe(true);
    expect(result.code).toBe("PROTOCOL");
    expect(result.message).toBe("Agent Runtime protocol versions do not overlap");
  }, 20_000);
});

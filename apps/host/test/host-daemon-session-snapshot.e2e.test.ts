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
  readonly sessionId: string;
  readonly listedCwd?: string;
  readonly enqueued: ReadonlyArray<{
    readonly recipientDeviceId: string;
    readonly plaintextLength: number;
  }>;
}

function parseSmokeResult(json: string): SmokeResult {
  const value = jsonObject(json);
  const ok = Reflect.get(value, "ok");
  const sessionIdValue = Reflect.get(value, "sessionId");
  const listedCwd = Reflect.get(value, "listedCwd");
  const enqueued = Reflect.get(value, "enqueued");
  if (typeof ok !== "boolean" || typeof sessionIdValue !== "string" || !Array.isArray(enqueued)) {
    throw new Error("Malformed smoke result");
  }
  return {
    ok,
    sessionId: sessionIdValue,
    ...(typeof listedCwd === "string" ? { listedCwd } : {}),
    enqueued: enqueued.map(parseEnqueueCall),
  };
}

function parseEnqueueCall(value: unknown): {
  readonly recipientDeviceId: string;
  readonly plaintextLength: number;
} {
  if (typeof value !== "object" || value === null) throw new Error("Expected a JSON object");
  const recipientDeviceId = Reflect.get(value, "recipientDeviceId");
  const plaintextLength = Reflect.get(value, "plaintextLength");
  if (typeof recipientDeviceId !== "string" || typeof plaintextLength !== "number") {
    throw new Error("Malformed enqueued entry");
  }
  return { recipientDeviceId, plaintextLength };
}

function jsonObject(json: string): object {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) throw new Error("Expected a JSON object");
  return value;
}

describe("Host Daemon session-snapshot forwarding to Relay end-to-end", () => {
  test("sends a HostSnapshot to the injected relay coordinator once, during HostDaemon.start(), scoped to the daemon's cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocket-omp-daemon-session-snapshot-e2e-"));
    directories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const resultPath = join(directory, "result.json");
    await writeFile(sessionPath, '{"type":"session"}\n');
    const bunExecutable = Bun.which("bun");
    if (bunExecutable === null) throw new Error("Bun executable not found");
    const child = Bun.spawn(
      [
        bunExecutable,
        resolve("apps/host/test/fixtures/daemon-session-snapshot-smoke.ts"),
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
    expect(result.listedCwd).toBe(directory);
    expect(result.enqueued).toHaveLength(1);
    expect(result.enqueued[0]?.recipientDeviceId).toBe("mobile-e2e");
    expect(result.enqueued[0]?.plaintextLength).toBeGreaterThan(0);
  }, 20_000);
});

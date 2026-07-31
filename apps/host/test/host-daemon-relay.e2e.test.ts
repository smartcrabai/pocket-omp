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
  readonly enqueued: ReadonlyArray<{
    readonly recipientDeviceId: string;
    readonly plaintextLength: number;
  }>;
}

function parseSmokeResult(json: string): SmokeResult {
  const value = jsonObject(json);
  const ok = Reflect.get(value, "ok");
  const sessionId = Reflect.get(value, "sessionId");
  const enqueued = Reflect.get(value, "enqueued");
  if (typeof ok !== "boolean" || typeof sessionId !== "string" || !Array.isArray(enqueued)) {
    throw new Error("Malformed smoke result");
  }
  return { ok, sessionId, enqueued: enqueued.map(parseEnqueueCall) };
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

describe("Host Daemon event forwarding to Relay end-to-end", () => {
  test("forwards a real Agent Runtime `event` frame to the injected relay coordinator while no request/response wait is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocket-omp-daemon-relay-e2e-"));
    directories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    const resultPath = join(directory, "result.json");
    await writeFile(sessionPath, '{"type":"session"}\n');
    const bunExecutable = Bun.which("bun");
    if (bunExecutable === null) throw new Error("Bun executable not found");
    const child = Bun.spawn(
      [
        bunExecutable,
        resolve("apps/host/test/fixtures/daemon-relay-smoke.ts"),
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
    expect(result.enqueued.length).toBeGreaterThan(0);
    expect(result.enqueued[0]?.recipientDeviceId).toBe("mobile-e2e");
    expect(result.enqueued[0]?.plaintextLength).toBeGreaterThan(0);
  }, 20_000);
});

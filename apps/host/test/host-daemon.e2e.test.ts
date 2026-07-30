import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Host Daemon end-to-end", () => {
  test("transfers file ownership through Runtime IPC and authenticated local control", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pocket-omp-daemon-e2e-"));
    directories.push(directory);
    const sessionPath = join(directory, "session.jsonl");
    await writeFile(sessionPath, '{"type":"session"}\n');
    const bunExecutable = Bun.which("bun");
    if (bunExecutable === null) throw new Error("Bun executable not found");
    const child = Bun.spawn(
      [bunExecutable, resolve("apps/host/test/fixtures/daemon-smoke.ts"), directory, sessionPath],
      {
        cwd: resolve("."),
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  }, 20_000);
});

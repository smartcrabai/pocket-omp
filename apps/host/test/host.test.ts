// Exercises the `pair` subcommand wired up in ../src/host.ts. That file is a
// bin script that dispatches on `process.argv` and calls `process.exit(...)`
// at the top level, and its option parsers (`parsePairOptions`,
// `requiredPositiveInteger`) are private, unexported helpers -- there is no
// way to unit-test them by import alone.
//
// Every scenario here runs `../src/host.ts` as a genuine subprocess via the
// `pair-command-smoke.ts` fixture (see that file's doc comment for why: an
// in-process `import()` of host.ts would drag it, and transitively
// host-daemon.ts, into this file's coverage tracking at near-0%, since only
// a sliver of their top-level dispatch runs per test case, and fail the
// repo's 80% per-file coverage gate -- exactly the failure mode this
// subprocess approach avoids, matching host-daemon.e2e.test.ts's existing
// convention). Never touches the real OS keychain (KeyringSecureKeyStore is
// only ever constructed; the fixture's fake `pairHost` never calls its
// put/get/delete) or the network (`PUBLIC_CONTROL_ORIGIN` is a syntactically
// valid but unreachable HTTPS origin, since pairHost itself is what's faked).
//
// stdout/stderr are captured through real temp files rather than
// `stdout: "pipe"`/`stderr: "pipe"`: under this repo's `bun test` (with
// `[test] coverage = true` in bunfig.toml), a piped child's stdio reliably
// comes back empty even though the child ran and exited correctly -- every
// other Bun.spawn-based e2e test in this suite sidesteps the same issue by
// only ever asserting stderr is empty or ignoring stdout entirely. Writing
// to a real file avoids it.
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fixturePath = resolve("apps/host/test/fixtures/pair-command-smoke.ts");
const bunExecutable = Bun.which("bun");
if (bunExecutable === null) throw new Error("Bun executable not found");

interface RunPairResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// Type-guards the fixture's echoed-options JSON (see pair-command-smoke.ts's
// PAIR_FIXTURE_ECHO_OPTIONS mode) instead of an unchecked `as` cast on
// JSON.parse's `any` result.
function parseEchoedOptions(json: string): { readonly routeId: string; readonly hostId: string } {
  const value: unknown = JSON.parse(json);
  if (
    typeof value !== "object" ||
    value === null ||
    !("routeId" in value) ||
    !("hostId" in value) ||
    typeof value.routeId !== "string" ||
    typeof value.hostId !== "string"
  ) {
    throw new Error(`Unexpected pair-command-smoke output: ${json}`);
  }
  return { routeId: value.routeId, hostId: value.hostId };
}

async function runPairCommand(
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<RunPairResult> {
  const dir = await mkdtemp(join(tmpdir(), "pocket-omp-pair-cli-"));
  const stdoutPath = join(dir, "stdout.txt");
  const stderrPath = join(dir, "stderr.txt");
  try {
    const child = Bun.spawn([bunExecutable, fixturePath, "pair", ...argv], {
      cwd: resolve("."),
      env: { ...process.env, PUBLIC_CONTROL_ORIGIN: "https://control.example.test", ...env },
      stdout: Bun.file(stdoutPath),
      stderr: Bun.file(stderrPath),
    });
    const exitCode = await child.exited;
    const [stdout, stderr] = await Promise.all([
      readFile(stdoutPath, "utf8"),
      readFile(stderrPath, "utf8"),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe("Host CLI pair command", () => {
  test("parsePairOptions defaults --host-name to the OS hostname", async () => {
    const { exitCode, stdout } = await runPairCommand([], {
      PAIR_FIXTURE_OUTCOME: "success",
      PAIR_FIXTURE_ECHO_OPTIONS: "1",
    });
    expect(exitCode).toBe(0);
    const parsed = parseEchoedOptions(stdout);
    expect(parsed.routeId).toBe(`hostName=${hostname()}`);
    expect(parsed.hostId).toBe("timeoutMs=undefined;pollIntervalMs=undefined");
  });

  test("parsePairOptions applies --host-name/--timeout-ms/--poll-interval-ms overrides", async () => {
    const { stdout } = await runPairCommand(
      ["--host-name", "custom-host", "--timeout-ms", "12345", "--poll-interval-ms", "6789"],
      { PAIR_FIXTURE_OUTCOME: "success", PAIR_FIXTURE_ECHO_OPTIONS: "1" },
    );
    const parsed = parseEchoedOptions(stdout);
    expect(parsed.routeId).toBe("hostName=custom-host");
    expect(parsed.hostId).toBe("timeoutMs=12345;pollIntervalMs=6789");
  });

  test("parsePairOptions rejects an unknown flag", async () => {
    const { exitCode, stderr } = await runPairCommand(["--bogus", "value"], {});
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown Host option: --bogus");
  });

  test.each([
    ["--timeout-ms", "0"],
    ["--timeout-ms", "-5"],
    ["--timeout-ms", "not-a-number"],
    ["--poll-interval-ms", "0"],
  ])("requiredPositiveInteger rejects %s %s", async (flag, value) => {
    const { exitCode, stderr } = await runPairCommand([flag, value], {});
    expect(exitCode).toBe(1);
    expect(stderr).toContain(`${flag} must be a positive integer`);
  });

  test("requiredPositiveInteger accepts a valid positive integer", async () => {
    const { exitCode, stdout } = await runPairCommand(["--timeout-ms", "5000"], {
      PAIR_FIXTURE_OUTCOME: "success",
      PAIR_FIXTURE_ECHO_OPTIONS: "1",
    });
    expect(exitCode).toBe(0);
    const parsed = parseEchoedOptions(stdout);
    expect(parsed.hostId).toBe("timeoutMs=5000;pollIntervalMs=undefined");
  });

  test("writes the paired JSON payload to stdout and exits 0 on success", async () => {
    const { exitCode, stdout } = await runPairCommand([], { PAIR_FIXTURE_OUTCOME: "success" });
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ paired: true, routeId: "route-abc", hostId: "host-xyz" });
  });

  test("reports failure to stderr and exits 1 when pairHost rejects", async () => {
    const { exitCode, stdout, stderr } = await runPairCommand([], {
      PAIR_FIXTURE_OUTCOME: "failure",
      PAIR_FIXTURE_ERROR: "network down",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("Pairing failed: network down\n");
  });
});

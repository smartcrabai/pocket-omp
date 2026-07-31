// Exercises the `pair` subcommand wired up in ../src/host.ts. That file is a
// bin script: it dispatches on `process.argv` and calls `process.exit(...)`
// at the top level, and its option parsers (`parsePairOptions`,
// `requiredPositiveInteger`) are private, unexported helpers. There is no way
// to unit-test them by import alone, so each test here:
//
//   1. Points `PUBLIC_CONTROL_ORIGIN` / `process.argv` at the scenario under
//      test.
//   2. Replaces the `./pairing` module (via `mock.module`, resolved from this
//      file to the same absolute path host.ts imports via `./pairing`) with a
//      fake `pairHost` that records the options it was called with and
//      resolves/rejects as directed -- this keeps every test fully offline
//      and never touches the real OS keychain (constructing
//      `KeyringSecureKeyStore` is inert; only its put/get/delete touch the
//      backend, and the fake `pairHost` never calls those).
//   3. Re-imports `../src/host.ts` with a cache-busting query string so its
//      top-level dispatch logic actually re-runs (plain re-imports would hit
//      the module cache and skip straight to a no-op).
//   4. Spies on `process.exit` and `Bun.write` to observe the exit code and
//      emitted stdout/stderr without tearing down the test process. The spy
//      captures only the FIRST exit call and the writes queued up to that
//      point: host.ts's `pair` branch never returns after its own
//      `process.exit`, so a faithful (non-throwing) mock falls through into
//      the file's trailing usage-banner branch, which would otherwise pollute
//      the captured output.
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { hostname } from "node:os";

// `mock.module` replaces "../src/pairing" for the whole test-runner process,
// not just this file (Bun does not isolate the module registry per test
// file), and it patches the *live* module namespace in place -- other files
// such as pairing.test.ts hold a binding straight into that namespace, so
// once any test below mocks this module, every consumer (including files
// that already ran their static imports) observes the fake until it is
// reverted. `{ ...RealPairingModule }` snapshots the real exports into an
// independent plain object *before* any mocking happens, so `afterAll` can
// restore them -- reusing the (also live) namespace object here would just
// hand back whatever the last mock left behind.
import * as RealPairingModule from "../src/pairing";
const realPairingExports = { ...RealPairingModule };

afterAll(() => {
  mock.module("../src/pairing", () => realPairingExports);
});

let caseCounter = 0;
const originalArgv = process.argv;
const originalControlOrigin = process.env.PUBLIC_CONTROL_ORIGIN;

afterEach(() => {
  process.argv = originalArgv;
  if (originalControlOrigin === undefined) delete process.env.PUBLIC_CONTROL_ORIGIN;
  else process.env.PUBLIC_CONTROL_ORIGIN = originalControlOrigin;
});

interface CapturedWrite {
  readonly dest: "stdout" | "stderr" | "other";
  readonly text: string;
}

interface RunPairResult {
  readonly exitCode: number | undefined;
  readonly writes: readonly CapturedWrite[];
  readonly capturedOptions: Record<string, unknown> | undefined;
}

type FakePairHost = (options: Record<string, unknown>) => Promise<unknown>;

async function runPairCommand(
  argv: readonly string[],
  fakePairHost: FakePairHost,
): Promise<RunPairResult> {
  let capturedOptions: Record<string, unknown> | undefined;
  mock.module("../src/pairing", () => ({
    pairHost: async (options: Record<string, unknown>) => {
      capturedOptions = options;
      return fakePairHost(options);
    },
  }));

  process.env.PUBLIC_CONTROL_ORIGIN = "https://control.example.test";
  process.argv = ["bun", "host.ts", "pair", ...argv];

  const allWrites: CapturedWrite[] = [];
  let exitCode: number | undefined;
  let writesAtExit: CapturedWrite[] = [];

  const writeSpy = spyOn(Bun, "write").mockImplementation(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: real signature is a wide overloaded union of destination/input types this fake never needs to distinguish.
    (async (dest: unknown, data: unknown) => {
      const destName = dest === Bun.stdout ? "stdout" : dest === Bun.stderr ? "stderr" : "other";
      allWrites.push({ dest: destName, text: String(data) });
      return 0;
    }) as typeof Bun.write,
  );
  const exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
    if (exitCode === undefined) {
      exitCode = code ?? 0;
      writesAtExit = [...allWrites];
    }
    // process.exit()'s real return type is `never` because the process
    // actually terminates; this fake must return normally so host.ts's
    // top-level dispatch keeps running (each `if` block still falls through
    // after calling it) instead of the test process exiting.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above; there is no real `never` value to return here.
    return undefined as never;
  });

  try {
    caseCounter += 1;
    await import(`../src/host.ts?pair-case=${caseCounter}`);
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { exitCode, writes: writesAtExit, capturedOptions };
}

async function expectPairRejection(argv: readonly string[], message: string): Promise<void> {
  process.argv = ["bun", "host.ts", "pair", ...argv];
  caseCounter += 1;
  await expect(import(`../src/host.ts?pair-case=${caseCounter}`)).rejects.toThrow(message);
}

describe("Host CLI pair command", () => {
  test("parsePairOptions defaults --host-name to the OS hostname", async () => {
    const { capturedOptions, exitCode } = await runPairCommand([], async () => ({
      routeId: "route-1",
      hostId: "host-1",
    }));
    expect(capturedOptions?.hostName).toBe(hostname());
    expect(capturedOptions?.timeoutMs).toBeUndefined();
    expect(capturedOptions?.pollIntervalMs).toBeUndefined();
    expect(exitCode).toBe(0);
  });

  test("parsePairOptions applies --host-name/--timeout-ms/--poll-interval-ms overrides", async () => {
    const { capturedOptions } = await runPairCommand(
      ["--host-name", "custom-host", "--timeout-ms", "12345", "--poll-interval-ms", "6789"],
      async () => ({ routeId: "route-1", hostId: "host-1" }),
    );
    expect(capturedOptions?.hostName).toBe("custom-host");
    expect(capturedOptions?.timeoutMs).toBe(12345);
    expect(capturedOptions?.pollIntervalMs).toBe(6789);
  });

  test("parsePairOptions rejects an unknown flag", async () => {
    await expectPairRejection(["--bogus", "value"], "Unknown Host option: --bogus");
  });

  test.each([
    ["--timeout-ms", "0"],
    ["--timeout-ms", "-5"],
    ["--timeout-ms", "not-a-number"],
    ["--poll-interval-ms", "0"],
  ])("requiredPositiveInteger rejects %s %s", async (flag, value) => {
    await expectPairRejection([flag, value], `${flag} must be a positive integer`);
  });

  test("requiredPositiveInteger accepts a valid positive integer", async () => {
    const { capturedOptions } = await runPairCommand(["--timeout-ms", "5000"], async () => ({
      routeId: "route-1",
      hostId: "host-1",
    }));
    expect(capturedOptions?.timeoutMs).toBe(5000);
  });

  test("writes the paired JSON payload to stdout and exits 0 on success", async () => {
    const { exitCode, writes } = await runPairCommand([], async () => ({
      routeId: "route-abc",
      hostId: "host-xyz",
    }));
    expect(exitCode).toBe(0);
    expect(writes).toEqual([
      {
        dest: "stdout",
        text: `${JSON.stringify({ paired: true, routeId: "route-abc", hostId: "host-xyz" })}\n`,
      },
    ]);
  });

  test("reports failure to stderr and exits 1 when pairHost rejects", async () => {
    const { exitCode, writes } = await runPairCommand([], async () => {
      throw new Error("network down");
    });
    expect(exitCode).toBe(1);
    expect(writes).toEqual([{ dest: "stderr", text: "Pairing failed: network down\n" }]);
  });
});

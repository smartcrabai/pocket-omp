// Spawned as a subprocess by ../host.test.ts so that importing ../../src/host.ts
// -- and transitively ../../src/host-daemon.ts -- never happens inside the
// coverage-tracked `bun test` process. Those two files are bin-script/daemon
// entry points this repo deliberately keeps out of bun's coverage
// instrumentation (see host-daemon.e2e.test.ts's Bun.spawn'd fixtures for the
// established pattern); importing them in-process in a *.test.ts file instead
// drags them into the coverage report at near-0% funcs/lines, since only a
// sliver of their top-level dispatch runs per test case, and fails the
// repo's 80% per-file coverage gate.
//
// Controlled entirely via environment variables (argv is reserved for the
// real `pair` subcommand args under test, forwarded by how host.test.ts
// invokes Bun.spawn):
//   PAIR_FIXTURE_OUTCOME=success -> fake pairHost resolves; if
//     PAIR_FIXTURE_ECHO_OPTIONS=1, the result's routeId/hostId encode the
//     options pairHost was actually called with, so host.test.ts can assert
//     on argv parsing through host.ts's real stdout JSON output.
//   PAIR_FIXTURE_OUTCOME=failure -> fake pairHost rejects with
//     PAIR_FIXTURE_ERROR's message.
//   unset -> ../../src/pairing is left untouched (used by the argv-parsing
//     failure cases, which throw before pairHost is ever called).
import { mock } from "bun:test";

const outcome = process.env.PAIR_FIXTURE_OUTCOME;
if (outcome !== undefined) {
  mock.module("../../src/pairing", () => ({
    pairHost: async (options: Record<string, unknown>) => {
      if (outcome === "failure") {
        throw new Error(process.env.PAIR_FIXTURE_ERROR ?? "fixture failure");
      }
      if (process.env.PAIR_FIXTURE_ECHO_OPTIONS === "1") {
        return {
          routeId: `hostName=${String(options.hostName)}`,
          hostId: `timeoutMs=${String(options.timeoutMs)};pollIntervalMs=${String(options.pollIntervalMs)}`,
        };
      }
      return { routeId: "route-abc", hostId: "host-xyz" };
    },
  }));
}

await import("../../src/host.ts");

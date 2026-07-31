#!/usr/bin/env bun
// Real-process proof that close()'s catch-block fallback (host-daemon.ts)
// does not hang or throw when shutdownRuntime fails before reaching its own
// cleanup -- here, because fixtures/fake-runtime-handshake.ts's
// --hang-on-shutdown mode completes a normal handshake but never answers a
// `shutdown` request, so shutdownRuntime's wait for `snapshot` times out.
//
// See apps/host/test/host-daemon-router-stop.test.ts for the companion proof
// that router.stop(), which this fallback calls, actually halts the reader
// pump (a real subprocess can't isolate that specific guarantee here -- see
// daemon-handshake-failure-smoke.ts's doc comment for why).
import { join } from "node:path";

import { HostDaemon } from "../../src/host-daemon";

const [directory, sessionPath, resultPath] = process.argv.slice(2);
if (directory === undefined || sessionPath === undefined || resultPath === undefined) {
  throw new Error("Expected directory, session path, and result path");
}
const runtimeExecutable = join(directory, "fake-runtime-handshake");
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "fake-runtime-handshake.ts")],
  compile: { outfile: runtimeExecutable },
});
if (!build.success) throw new Error("Unable to compile fake handshake Runtime");
const paths = {
  directory: join(directory, "run"),
  endpoint: join(directory, "run", "control.sock"),
  secretPath: join(directory, "run", "control.secret"),
};

const daemon = await HostDaemon.start({
  cwd: directory,
  sessionPath,
  runtimeExecutable,
  runtimeArguments: ["--hang-on-shutdown"],
  paths,
});
const startedAtMs = Date.now();
await daemon.close();
const elapsedMs = Date.now() - startedAtMs;
await Bun.write(resultPath, `${JSON.stringify({ ok: true, elapsedMs })}\n`);

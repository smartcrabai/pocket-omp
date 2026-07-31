#!/usr/bin/env bun
// Real-process proof that startRuntime's hello-wait-timeout and
// protocol-version-mismatch failure paths (host-daemon.ts) actually surface
// as the expected HostDaemonError, driven through
// fixtures/fake-runtime-handshake.ts -- a hand-rolled fake Runtime that
// fixtures/fake-runtime.ts's RuntimeFrameServer cannot impersonate, since it
// always sends a valid, matching `hello` immediately.
//
// See apps/host/test/host-daemon-router-stop.test.ts for the companion proof
// that RuntimeFrameRouter.stop() -- which both of these failure paths call
// -- actually halts the reader pump. A real subprocess can't isolate that
// specific guarantee here: RuntimeProcessClient.stderr()/dispose(), which
// startRuntime's catch blocks await immediately before/after calling
// router.stop(), only resolve once this fake process has fully exited --
// which itself already ends the frame stream naturally, masking whether
// router.stop() specifically is what halted the pump.
import { join } from "node:path";

import { HostDaemon, HostDaemonError } from "../../src/host-daemon";

const [directory, sessionPath, resultPath, mode] = process.argv.slice(2);
if (
  directory === undefined ||
  sessionPath === undefined ||
  resultPath === undefined ||
  (mode !== "no-hello" && mode !== "bad-hello")
) {
  throw new Error("Expected directory, session path, result path, and mode (no-hello|bad-hello)");
}
const runtimeExecutable = join(directory, "fake-runtime-handshake");
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "fake-runtime-handshake.ts")],
  compile: { outfile: runtimeExecutable },
});
if (!build.success) throw new Error("Unable to compile fake handshake Runtime");

// startRuntime throws before HostDaemon.start() ever reaches
// LocalControlServer.start(), so no `paths` option is needed for either
// failure mode this fixture drives.
let code: string | undefined;
let message: string | undefined;
try {
  await HostDaemon.start({
    cwd: directory,
    sessionPath,
    runtimeExecutable,
    runtimeArguments: [`--${mode}`],
  });
  throw new Error("Expected HostDaemon.start() to reject");
} catch (error) {
  if (!(error instanceof HostDaemonError)) throw error;
  code = error.code;
  message = error.message;
}

await Bun.write(resultPath, `${JSON.stringify({ ok: true, code, message })}\n`);

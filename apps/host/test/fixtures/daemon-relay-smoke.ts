#!/usr/bin/env bun
// Real-process proof that HostDaemon forwards an Agent Runtime `event` frame
// to an injected relay coordinator (see runtime-frame-router.ts /
// runtime-event-forwarder.ts). Modeled on daemon-smoke.ts, but:
//   - spawns fake-runtime.ts with --emit-event, so it sends one autonomous
//     `event` frame after `ready` (see fake-runtime.ts's `oneEvent`).
//   - wires HostDaemonOptions.relay with a fake coordinator that just
//     records enqueue() calls, instead of leaving it undefined.
//   - polls for that event to be forwarded *before* driving the TUI handoff,
//     specifically to exercise the scenario the frame-multiplexing fix
//     targets: an `event` frame arriving while nobody is waiting on any
//     request/response (HostDaemon.start() has already returned; the next
//     local-control request hasn't been sent yet).
// The result is written to `resultPath` (a file, not stdout): piping a
// spawned child's stdout back to the parent test process has proven
// unreliable in this environment specifically when the child's cwd is this
// repo's workspace root (stderr piping is unaffected), which is exactly why
// the existing daemon-smoke.ts/host-daemon.e2e.test.ts never reads
// child.stdout either -- it uses `stdout: "ignore"` and only asserts on
// stderr/exitCode.
import { create } from "@bufbuild/protobuf";
import {
  PrepareTuiHandoffRequestSchema,
  TuiExitedRequestSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import { join } from "node:path";

import { HostDaemon } from "../../src/host-daemon";
import { requestLocalControl } from "../../src/local-control";
import type { RuntimeEventRelay } from "../../src/runtime-event-forwarder";

const [directory, sessionPath, resultPath] = process.argv.slice(2);
if (directory === undefined || sessionPath === undefined || resultPath === undefined) {
  throw new Error("Expected directory, session path, and result path");
}
const runtimeExecutable = join(directory, "fake-runtime");
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "fake-runtime.ts")],
  compile: { outfile: runtimeExecutable },
});
if (!build.success) throw new Error("Unable to compile fake Runtime");
const paths = {
  directory: join(directory, "run"),
  endpoint: join(directory, "run", "control.sock"),
  secretPath: join(directory, "run", "control.secret"),
};

interface EnqueueCall {
  readonly recipientDeviceId: string;
  readonly plaintextLength: number;
}
const enqueued: EnqueueCall[] = [];
const relay: RuntimeEventRelay = {
  coordinator: {
    enqueue: async (recipientDeviceId: string, plaintext: Uint8Array) => {
      enqueued.push({ recipientDeviceId, plaintextLength: plaintext.byteLength });
      return { duplicate: false };
    },
  },
  hostId: "host-e2e",
  recipientDeviceId: () => "mobile-e2e",
};

const daemon = await HostDaemon.start({
  cwd: directory,
  sessionPath,
  runtimeExecutable,
  runtimeArguments: ["--emit-event"],
  paths,
  relay,
});
try {
  // Give the router's continuous reader loop a chance to read and forward
  // fake Runtime's one autonomous `event` frame before driving the TUI
  // handoff below -- this is exactly the scenario the frame-multiplexing
  // fix targets: nobody is waiting on a request/response at this point,
  // only the background reader loop is active.
  const deadline = Date.now() + 5_000;
  while (enqueued.length === 0 && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Polling requires a bounded wait between checks.
    await Bun.sleep(20);
  }

  const prepare = await requestLocalControl(
    {
      case: "prepareTuiHandoff",
      value: create(PrepareTuiHandoffRequestSchema, {
        sessionId: daemon.sessionId,
        abortActiveRun: false,
      }),
    },
    paths,
  );
  if (prepare.body.case !== "handoffReady") throw new Error("Expected handoffReady");
  const exited = await requestLocalControl(
    {
      case: "tuiExited",
      value: create(TuiExitedRequestSchema, {
        handoffTicket: prepare.body.value.handoffTicket,
        exitCode: 0,
        finalFileFingerprint: prepare.body.value.fileFingerprint,
      }),
    },
    paths,
  );
  if (exited.body.case !== "tuiExited") throw new Error("Expected tuiExited acknowledgement");
  await Bun.write(
    resultPath,
    `${JSON.stringify({ ok: true, sessionId: daemon.sessionId, enqueued })}\n`,
  );
} finally {
  await daemon.close();
}

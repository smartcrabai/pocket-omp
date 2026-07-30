#!/usr/bin/env bun
import { create } from "@bufbuild/protobuf";
import {
  PrepareTuiHandoffRequestSchema,
  TuiExitedRequestSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import { join } from "node:path";

import { HostDaemon } from "../../src/host-daemon";
import { requestLocalControl } from "../../src/local-control";

const [directory, sessionPath] = process.argv.slice(2);
if (directory === undefined || sessionPath === undefined) {
  throw new Error("Expected directory and session path");
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
const daemon = await HostDaemon.start({
  cwd: directory,
  sessionPath,
  runtimeExecutable,
  paths,
});
try {
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
  await Bun.write(Bun.stdout, `${JSON.stringify({ ok: true, sessionId: daemon.sessionId })}\n`);
} finally {
  await daemon.close();
}

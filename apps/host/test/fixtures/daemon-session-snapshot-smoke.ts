#!/usr/bin/env bun
// Real-process proof that HostDaemon.start() sends a session-list
// HostSnapshot to an injected relay coordinator at startup (see
// ../../src/session-snapshot-forwarder.ts). Modeled on
// daemon-relay-smoke.ts, but simpler: unlike a Runtime `event` frame (which
// arrives asynchronously off the Runtime subprocess and therefore requires
// polling in that fixture), forwardSessionSnapshot is fully awaited inside
// HostDaemon.start() itself, so by the time start() resolves, enqueue() has
// already been called (or the isolated failure has already been reported).
// There is nothing to poll for.
//
// sessionSnapshot.sessionListPort is a fake (not the real
// OmpSessionListAdapter/SessionManager.list): this fixture's job is only to
// prove HostDaemon actually invokes the send-at-startup trigger end to end
// through a real HostDaemon.start(), not to re-prove SessionManager.list
// wiring, which packages/omp-sdk-adapter/test/session-list.test.ts already
// covers directly.
import { create } from "@bufbuild/protobuf";
import {
  PrepareTuiHandoffRequestSchema,
  TuiExitedRequestSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import { join } from "node:path";

import { sessionId } from "@pocket-omp/agent-domain";
import type { OmpSessionSummary } from "@pocket-omp/host-core";

import { HostDaemon } from "../../src/host-daemon";
import { requestLocalControl } from "../../src/local-control";
import type { SessionSnapshotRelay } from "../../src/session-snapshot-forwarder";

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
const fakeSession: OmpSessionSummary = {
  sessionId: sessionId("session-fixture"),
  path: sessionPath,
  cwd: directory,
  title: "Fixture session",
  updatedAtMs: 1_700_000_000_000n,
  compatibility: "indeterminate",
};
let listedCwd: string | undefined;
const sessionSnapshot: SessionSnapshotRelay = {
  sessionListPort: {
    listSessions: async (input) => {
      listedCwd = input.cwd;
      return [fakeSession];
    },
  },
  coordinator: {
    enqueue: async (recipientDeviceId: string, plaintext: Uint8Array) => {
      enqueued.push({ recipientDeviceId, plaintextLength: plaintext.byteLength });
      return { duplicate: false };
    },
  },
  hostId: "host-e2e",
  displayName: "Fixture Host",
  recipientDeviceId: () => "mobile-e2e",
};

const daemon = await HostDaemon.start({
  cwd: directory,
  sessionPath,
  runtimeExecutable,
  paths,
  sessionSnapshot,
});
try {
  // Confirm the Daemon is still fully functional (control server up, Runtime
  // handshake completed) with sessionSnapshot wired -- not just that it
  // sends a snapshot, but that doing so doesn't disturb anything else.
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
    `${JSON.stringify({ ok: true, sessionId: daemon.sessionId, listedCwd, enqueued })}\n`,
  );
} finally {
  await daemon.close();
}

import { create } from "@bufbuild/protobuf";
import {
  PrepareTuiHandoffRequestSchema,
  TuiExitedRequestSchema,
} from "@pocket-omp/proto/hostlocal/v1";

import { requestLocalControl } from "./local-control";
import { OMP_VERSION, runCompanion } from "./shared";

export async function runTuiHandoff(args: readonly string[]): Promise<number> {
  const sessionId = args[0];
  if (sessionId === undefined || sessionId.startsWith("-")) {
    throw new TuiHandoffError("SESSION", "Usage: pocket-omp tui <session-id> [--abort-active-run]");
  }
  const unknown = args.slice(1).filter((value) => value !== "--abort-active-run");
  if (unknown.length !== 0)
    throw new TuiHandoffError("OPTION", `Unknown TUI option: ${unknown[0]}`);
  const response = await requestLocalControl({
    case: "prepareTuiHandoff",
    value: create(PrepareTuiHandoffRequestSchema, {
      sessionId,
      abortActiveRun: args.includes("--abort-active-run"),
    }),
  });
  if (response.body.case === "error") {
    throw new TuiHandoffError(response.body.value.code, response.body.value.message);
  }
  if (response.body.case !== "handoffReady") {
    throw new TuiHandoffError("PROTOCOL", "Host Daemon returned an unexpected handoff response");
  }
  const handoff = response.body.value;
  if (handoff.expiresAtMs < BigInt(Date.now())) {
    throw new TuiHandoffError("EXPIRED", "Host Daemon handoff expired before TUI launch");
  }
  if (handoff.tuiVersion !== OMP_VERSION) {
    throw new TuiHandoffError(
      "VERSION",
      `Host requires OMP ${handoff.tuiVersion}, bundled version is ${OMP_VERSION}`,
    );
  }
  const before = await sha256File(handoff.sessionPath);
  if (!constantTimeEqual(before, handoff.fileFingerprint)) {
    throw new TuiHandoffError("FINGERPRINT", "Session file changed during ownership handoff");
  }

  const exitCode = await runCompanion("omp", [
    "--resume",
    handoff.sessionPath,
    "--cwd",
    handoff.cwd,
  ]);
  const finalFileFingerprint = await sha256File(handoff.sessionPath);
  const acknowledgement = await requestLocalControl({
    case: "tuiExited",
    value: create(TuiExitedRequestSchema, {
      handoffTicket: handoff.handoffTicket,
      exitCode,
      finalFileFingerprint,
    }),
  });
  if (acknowledgement.body.case === "error") {
    throw new TuiHandoffError(acknowledgement.body.value.code, acknowledgement.body.value.message);
  }
  if (acknowledgement.body.case !== "tuiExited") {
    throw new TuiHandoffError("PROTOCOL", "Host Daemon did not acknowledge TUI exit");
  }
  return exitCode;
}

async function sha256File(path: string): Promise<Uint8Array> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return new Uint8Array(hasher.digest());
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export class TuiHandoffError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TuiHandoffError";
  }
}

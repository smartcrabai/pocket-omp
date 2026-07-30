#!/usr/bin/env bun
import { inspectAtomicRelease } from "./doctor";
import {
  formatVersion,
  isVersionRequest,
  RELEASE_VERSION,
  runCompanion,
  wantsJson,
} from "./shared";

import { runTuiHandoff } from "./tui-handoff";
import { runHostUpdate, runPreparedUpdateHelper, runUpdateHelperCleanup } from "./updater";

process.exitCode = await main(process.argv.slice(2));

async function main(args: readonly string[]): Promise<number> {
  const command = args[0];
  if (isVersionRequest(args)) {
    await Bun.write(Bun.stdout, formatVersion("pocket-omp", wantsJson(args)));
    return 0;
  }

  if (command === "__apply-update") return runPreparedUpdateHelper(args.slice(1));
  if (command === "__cleanup-update-helper") return runUpdateHelperCleanup(args.slice(1));
  if (command === "update") return runHostUpdate(args.slice(1));

  if (command === "doctor") {
    const inspection = await inspectAtomicRelease();
    const output = wantsJson(args)
      ? `${JSON.stringify(inspection)}\n`
      : `${inspection.artifactKind}; releaseReady=${inspection.releaseReady}\n${inspection.results
          .map((result) => `${result.ok ? "ok" : "error"}  ${result.unit}: ${result.detail}`)
          .join("\n")}\n`;
    await Bun.write(Bun.stdout, output);
    return inspection.ok ? 0 : 1;
  }

  if (command === "tui") return runTuiHandoff(args.slice(1));

  const delegates: Readonly<Record<string, string>> = {
    host: "pocket-omp-host",
    runtime: "pocket-omp-agent-runtime",
  };
  const delegate = command === undefined ? undefined : delegates[command];
  if (delegate !== undefined) return runCompanion(delegate, args.slice(1));

  await Bun.write(
    Bun.stdout,
    `Pocket OMP ${RELEASE_VERSION}\n\nUsage:\n  pocket-omp doctor [--json]\n  pocket-omp update [--manifest-url <https-url>] [--install-dir <path>]\n  pocket-omp host [arguments...]\n  pocket-omp runtime [arguments...]\n  pocket-omp tui <session-id> [--abort-active-run]\n  pocket-omp --version [--json]\n`,
  );
  return command === undefined || command === "help" || command === "--help" ? 0 : 2;
}

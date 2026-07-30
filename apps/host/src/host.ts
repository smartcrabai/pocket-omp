#!/usr/bin/env bun
import { resolve } from "node:path";

import { HostDaemon } from "./host-daemon";
import { localControlPaths } from "./local-control";
import {
  companionPath,
  formatVersion,
  isVersionRequest,
  RELEASE_VERSION,
  wantsJson,
} from "./shared";

const args = process.argv.slice(2);
if (isVersionRequest(args)) {
  await Bun.write(Bun.stdout, formatVersion("pocket-omp-host", wantsJson(args)));
  process.exit(0);
}

const command = args[0];
if (command === "run" || command === "serve") {
  process.title = "pocket-omp-host";
  const options = parseServeOptions(args.slice(1));
  const paths = localControlPaths(
    options.runtimeDirectory === undefined
      ? process.env
      : { ...process.env, POCKET_OMP_RUNTIME_DIR: options.runtimeDirectory },
  );
  const daemon = await HostDaemon.start({
    cwd: options.cwd,
    sessionPath: options.sessionPath,
    runtimeExecutable: companionPath("pocket-omp-agent-runtime"),
    paths,
  });
  await Bun.write(
    Bun.stdout,
    `${JSON.stringify({ ready: true, sessionId: daemon.sessionId, endpoint: paths.endpoint })}\n`,
  );
  await waitForShutdownSignal();
  await daemon.close();
  process.exit(0);
}

await Bun.write(
  Bun.stdout,
  `Pocket OMP Host ${RELEASE_VERSION}\n\nUsage:\n  pocket-omp-host serve --session-path <path> [--cwd <path>] [--runtime-dir <path>]\n  pocket-omp-host --version [--json]\n\nThe serve command owns an OMP session through the isolated Agent Runtime and exposes authenticated local control.\n`,
);
process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 2);

function parseServeOptions(values: readonly string[]): {
  readonly sessionPath: string;
  readonly cwd: string;
  readonly runtimeDirectory?: string;
} {
  let sessionPath: string | undefined;
  let cwd = process.cwd();
  let runtimeDirectory: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index + 1];
    switch (values[index]) {
      case "--session-path":
        sessionPath = requiredOption("--session-path", value);
        index += 1;
        break;
      case "--cwd":
        cwd = requiredOption("--cwd", value);
        index += 1;
        break;
      case "--runtime-dir":
        runtimeDirectory = requiredOption("--runtime-dir", value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown Host option: ${values[index]}`);
    }
  }
  if (sessionPath === undefined) throw new Error("--session-path is required");
  return {
    sessionPath: resolve(sessionPath),
    cwd: resolve(cwd),
    ...(runtimeDirectory === undefined ? {} : { runtimeDirectory: resolve(runtimeDirectory) }),
  };
}

function requiredOption(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} requires a value`);
  return value;
}

function waitForShutdownSignal(): Promise<void> {
  const { promise, resolve: resolveSignal } = Promise.withResolvers<void>();
  const stop = (): void => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    resolveSignal();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return promise;
}

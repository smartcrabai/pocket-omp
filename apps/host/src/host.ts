#!/usr/bin/env bun
import { hostname } from "node:os";
import { resolve } from "node:path";

import { loadPublicConfig } from "@pocket-omp/config";
import { KeyringSecureKeyStore } from "@pocket-omp/host-adapters";

import { HostDaemon } from "./host-daemon";
import { localControlPaths } from "./local-control";
import { pairHost } from "./pairing";
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

if (command === "pair") {
  process.title = "pocket-omp-host-pair";
  const options = parsePairOptions(args.slice(1));
  const config = loadPublicConfig(process.env);
  const controller = new AbortController();
  const stopOnSignal = (): void => controller.abort();
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);
  try {
    const result = await pairHost({
      hostName: options.hostName,
      controlOrigin: config.controlOrigin,
      keyStore: new KeyringSecureKeyStore(),
      signal: controller.signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({ paired: true, routeId: result.routeId, hostId: result.hostId })}\n`,
    );
    process.exit(0);
  } catch (error) {
    await Bun.write(
      Bun.stderr,
      `Pairing failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  } finally {
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
  }
}

await Bun.write(
  Bun.stdout,
  `Pocket OMP Host ${RELEASE_VERSION}\n\nUsage:\n  pocket-omp-host serve --session-path <path> [--cwd <path>] [--runtime-dir <path>]\n  pocket-omp-host pair [--host-name <name>] [--timeout-ms <n>] [--poll-interval-ms <n>]\n  pocket-omp-host --version [--json]\n\nThe serve command owns an OMP session through the isolated Agent Runtime and exposes authenticated local control.\nThe pair command claims a mobile-scanned pairing code, derives the pairwise E2EE key, and stores Host credentials.\n`,
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

function parsePairOptions(values: readonly string[]): {
  readonly hostName: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
} {
  let hostNameOption = hostname();
  let timeoutMs: number | undefined;
  let pollIntervalMs: number | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index + 1];
    switch (values[index]) {
      case "--host-name":
        hostNameOption = requiredOption("--host-name", value);
        index += 1;
        break;
      case "--timeout-ms":
        timeoutMs = requiredPositiveInteger("--timeout-ms", value);
        index += 1;
        break;
      case "--poll-interval-ms":
        pollIntervalMs = requiredPositiveInteger("--poll-interval-ms", value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown Host option: ${values[index]}`);
    }
  }
  return {
    hostName: hostNameOption,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
  };
}

function requiredPositiveInteger(name: string, value: string | undefined): number {
  const parsed = Number(requiredOption(name, value));
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
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

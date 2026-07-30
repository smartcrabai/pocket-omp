#!/usr/bin/env bun
import { OmpSdkSessionFactory } from "@pocket-omp/omp-sdk-adapter";

import { formatVersion, isVersionRequest } from "./shared";
import { RuntimeFrameServer } from "./runtime-server";

const args = process.argv.slice(2);
if (isVersionRequest(args)) {
  await Bun.write(Bun.stdout, formatVersion("pocket-omp-agent-runtime", args.includes("--json")));
  process.exit(0);
}
if (args[0] !== undefined && args[0] !== "serve") {
  await Bun.write(Bun.stderr, "Usage: pocket-omp-agent-runtime [serve] | --version [--json]\n");
  process.exit(2);
}

const runtimeId = requiredEnvironment("POCKET_OMP_RUNTIME_ID");
const runtimeGeneration = parseGeneration(requiredEnvironment("POCKET_OMP_RUNTIME_GENERATION"));
const nowMs = (): bigint => BigInt(Date.now());
const stdout = Bun.stdout.writer();
const server = new RuntimeFrameServer(
  {
    runtimeId,
    runtimeGeneration,
    nowMs,
    monotonicMs: () => BigInt(Math.floor(performance.now())),
    factory: async () =>
      OmpSdkSessionFactory.initialize({
        ...(process.env.POCKET_OMP_AGENT_DIR === undefined
          ? {}
          : { agentDir: process.env.POCKET_OMP_AGENT_DIR }),
        runtimeGeneration,
        nowMs,
        newId: () => crypto.randomUUID(),
      }),
  },
  {
    write: async (bytes) => {
      await stdout.write(bytes);
      await stdout.flush();
    },
  },
);

try {
  await server.run(Bun.stdin.stream());
} catch (error) {
  await Bun.write(Bun.stderr, `${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await stdout.end();
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function parseGeneration(value: string): bigint {
  const generation = BigInt(value);
  if (generation <= 0n) throw new Error("POCKET_OMP_RUNTIME_GENERATION must be positive");
  return generation;
}

#!/usr/bin/env bun
import type { AgentSessionFactory, AgentSessionPort } from "@pocket-omp/agent-runtime-core";
import { eventId, runId, sessionId, type AgentDomainEvent } from "@pocket-omp/agent-domain";

import { RuntimeFrameServer } from "../../src/runtime-server";

const runtimeId = process.env.POCKET_OMP_RUNTIME_ID;
const generation = process.env.POCKET_OMP_RUNTIME_GENERATION;
if (runtimeId === undefined || generation === undefined) throw new Error("Missing runtime fence");
// Opt-in (via --emit-event) so the default e2e smoke test
// (fixtures/daemon-smoke.ts, run through HostDaemon.start() without any
// relay wired) is completely unaffected: this fixture is shared, and that
// test only asserts empty stderr / exitCode 0, never anything about events.
// fixtures/daemon-relay-smoke.ts passes --emit-event to exercise Host's
// frame-multiplexing + event-forwarding path against a real Agent Runtime
// process instead of a fake in-memory frame stream.
const emitEvent = process.argv.includes("--emit-event");
let sessionPath = "";
const session: AgentSessionPort = {
  sessionId: sessionId("session-e2e"),
  capabilities: {
    sdkVersion: "17.1.5",
    sessionFormatVersion: "1",
    sessionPersistence: true,
    extensionUiKinds: [],
    tools: [],
    steering: true,
    followUp: true,
    compaction: true,
    subagents: true,
    mcp: true,
    lsp: true,
  },
  execute: async () => undefined,
  events: () => (emitEvent ? oneEvent(BigInt(generation)) : emptyEvents()),
  flush: async () => sha256File(sessionPath),
  dispose: async () => undefined,
};
const factory: AgentSessionFactory = {
  create: async (input) => {
    sessionPath = input.sessionPath ?? "";
    return session;
  },
};
const stdout = Bun.stdout.writer();
const server = new RuntimeFrameServer(
  {
    runtimeId,
    runtimeGeneration: BigInt(generation),
    nowMs: () => BigInt(Date.now()),
    monotonicMs: () => BigInt(Math.floor(performance.now())),
    factory: async () => factory,
  },
  {
    write: async (bytes) => {
      stdout.write(bytes);
      await stdout.flush();
    },
  },
);
await server.run(Bun.stdin.stream());
stdout.end();

async function* emptyEvents(): AsyncIterable<never> {}

async function* oneEvent(runtimeGeneration: bigint): AsyncIterable<AgentDomainEvent> {
  yield {
    kind: "agent-started",
    eventId: eventId("event-e2e-1"),
    sessionId: sessionId("session-e2e"),
    runId: runId("run-e2e-1"),
    revision: 1n,
    createdAtMs: BigInt(Date.now()),
    runtimeGeneration,
  };
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

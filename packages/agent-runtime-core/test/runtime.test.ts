import { expect, test } from "bun:test";
import {
  commandId,
  sessionId,
  type AgentCommand,
  type OmpCapabilityManifest,
} from "@pocket-omp/agent-domain";
import {
  AgentRuntimeApplication,
  type AgentSessionFactory,
  type AgentSessionPort,
} from "../src/index";

const capabilities: OmpCapabilityManifest = {
  sdkVersion: "test",
  sessionPersistence: true,
  extensionUiKinds: [],
  tools: [],
  steering: true,
  followUp: true,
  compaction: true,
  subagents: false,
  mcp: false,
  lsp: false,
};

function makeSession(overrides: Partial<AgentSessionPort> = {}): AgentSessionPort {
  return {
    sessionId: sessionId("session-1"),
    capabilities,
    execute: async () => undefined,
    async *events() {},
    flush: async () => "fingerprint-1",
    dispose: async () => undefined,
    ...overrides,
  };
}

function makeRuntime(
  session: AgentSessionPort,
  factory?: AgentSessionFactory,
): AgentRuntimeApplication {
  return new AgentRuntimeApplication(factory ?? { create: async () => session });
}

async function expectRejected(
  promise: Promise<unknown>,
  expected: { readonly name?: string; readonly message?: string },
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject(expected);
}

const startInput = {
  cwd: "/workspace/project",
  sessionPath: "/workspace/project/.omp/session.jsonl",
  allowedTools: ["read", "write"],
};

test("runtime starts once with persistent sessions and accepts commands idempotently", async () => {
  const calls: unknown[] = [];
  const session = makeSession();
  const factory: AgentSessionFactory = {
    create: async (input) => {
      calls.push(input);
      return session;
    },
  };
  const runtime = makeRuntime(session, factory);

  expect(runtime.lifecycle).toEqual({ kind: "starting" });
  await expectRejected(runtime.accept({ kind: "abort", commandId: commandId("before-start") }), {
    name: "RuntimeInvariantError",
    message: "Runtime is not ready",
  });
  expect(await runtime.start(startInput)).toBe(session);
  expect(calls).toEqual([startInput]);
  expect(runtime.lifecycle).toEqual({ kind: "ready", session });
  await expectRejected(runtime.start(startInput), {
    name: "RuntimeInvariantError",
    message: "Runtime can only start once",
  });

  const accepted: AgentCommand[] = [];
  const acceptingSession = makeSession({
    execute: async (command) => {
      accepted.push(command);
    },
  });
  const acceptingRuntime = makeRuntime(acceptingSession);
  await acceptingRuntime.start(startInput);
  const command: AgentCommand = {
    kind: "submit-prompt",
    commandId: commandId("command-1"),
    text: "hello",
  };
  expect(await acceptingRuntime.accept(command)).toEqual({ duplicate: false });
  expect(await acceptingRuntime.accept(command)).toEqual({ duplicate: true });
  expect(accepted).toEqual([command]);
});

test("runtime releases a command id after execution fails so the command can be retried", async () => {
  let attempts = 0;
  const session = makeSession({
    execute: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary execution failure");
    },
  });
  const runtime = makeRuntime(session);
  await runtime.start(startInput);
  const command: AgentCommand = {
    kind: "steer",
    commandId: commandId("command-retry"),
    text: "focus",
  };

  await expectRejected(runtime.accept(command), {
    name: "Error",
    message: "temporary execution failure",
  });
  expect(await runtime.accept(command)).toEqual({ duplicate: false });
  expect(await runtime.accept(command)).toEqual({ duplicate: true });
  expect(attempts).toBe(2);
});

test("runtime disposes a session when file-backed persistence is unavailable", async () => {
  let disposed = 0;
  const session = makeSession({
    capabilities: { ...capabilities, sessionPersistence: false },
    dispose: async () => {
      disposed += 1;
    },
  });
  const runtime = makeRuntime(session);

  await expectRejected(runtime.start(startInput), {
    name: "RuntimeInvariantError",
    message: "Production runtime requires file-backed persistence",
  });
  expect(disposed).toBe(1);
  expect(runtime.lifecycle).toEqual({ kind: "starting" });
});

test("shutdown flushes and disposes before recording the final fingerprint", async () => {
  const order: string[] = [];
  let finishFlush!: (fingerprint: string) => void;
  const flushing = new Promise<string>((resolve) => {
    finishFlush = resolve;
  });
  const session = makeSession({
    flush: () => {
      order.push("flush");
      return flushing;
    },
    dispose: async () => {
      order.push("dispose");
    },
  });
  const runtime = makeRuntime(session);
  await runtime.start(startInput);

  const shutdown = runtime.shutdown();
  expect(runtime.lifecycle).toEqual({ kind: "stopping", session });
  expect(order).toEqual(["flush"]);
  finishFlush("final-fingerprint");

  expect(await shutdown).toBe("final-fingerprint");
  expect(order).toEqual(["flush", "dispose"]);
  expect(runtime.lifecycle).toEqual({ kind: "stopped", finalFingerprint: "final-fingerprint" });
  await expectRejected(runtime.shutdown(), {
    name: "RuntimeInvariantError",
    message: "Runtime is not ready",
  });
});

test("fault records its code and does not replace a completed shutdown", async () => {
  const runtime = makeRuntime(makeSession());
  runtime.fault("STARTUP_FAILED");
  expect(runtime.lifecycle).toEqual({ kind: "faulted", code: "STARTUP_FAILED" });

  const stoppedRuntime = makeRuntime(makeSession());
  await stoppedRuntime.start(startInput);
  await stoppedRuntime.shutdown();
  stoppedRuntime.fault("LATE_FAILURE");
  expect(stoppedRuntime.lifecycle).toEqual({ kind: "stopped", finalFingerprint: "fingerprint-1" });
});

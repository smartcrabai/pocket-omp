import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { commandId, sessionId, type AgentCommand } from "@pocket-omp/agent-domain";
import type { AgentSessionFactory, AgentSessionPort } from "@pocket-omp/agent-runtime-core";
import {
  encodeRuntimeFrame,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeFrameDecoder,
} from "@pocket-omp/agent-runtime-protocol";
import {
  RuntimeCommandSchema,
  RuntimeFrameSchema,
  RuntimeHeartbeatSchema,
  RuntimeHelloSchema,
  RuntimeShutdownSchema,
  RuntimeStartSchema,
  type RuntimeFrame,
} from "@pocket-omp/proto/runtime/v1";

import { RuntimeFrameServer, RuntimeServerError } from "../src/runtime-server";

const runtimeId = "runtime-command-test";
const runtimeGeneration = 7n;

describe("RuntimeFrameServer command and protocol coverage", () => {
  test("requires a nonzero runtime generation", () => {
    expect(
      () =>
        new RuntimeFrameServer(
          {
            runtimeId,
            runtimeGeneration: 0n,
            nowMs: () => 10n,
            monotonicMs: () => 20n,
            factory: async () => sessionFactory(),
          },
          { write: async () => undefined },
        ),
    ).toThrow(RuntimeServerError);
  });

  test("answers heartbeats and decodes each supported command", async () => {
    const received: AgentCommand[] = [];
    const factory = sessionFactory(async (command) => {
      received.push(command);
    });
    const frames = [
      hostFrame("heartbeat-1", {
        case: "heartbeat",
        value: create(RuntimeHeartbeatSchema, {}),
      }),
      hostFrame("start-1", {
        case: "start",
        value: create(RuntimeStartSchema, { cwd: "/workspace", allowedTools: [] }),
      }),
      commandFrame("steer", "steer", { text: "guide" }),
      commandFrame("follow-up", "follow-up", { text: "continue" }),
      commandFrame("abort", "abort", {}),
      commandFrame("compact", "compact", {}),
      commandFrame("set-model", "set-model", { provider: "openai", modelId: "model-1" }),
      commandFrame("ui-response", "ui-response", {
        uiRequestId: "ui-1",
        response: "eWVz",
        displayedContentHash: "aGFzaA==",
      }),
      hostFrame("shutdown-1", {
        case: "shutdown",
        value: create(RuntimeShutdownSchema, { reason: "done", deadlineMs: 100n }),
      }),
    ];

    const output = await runServer(frames, factory);
    const decoded = decodeAll(output);
    const heartbeat = decoded.find((frame) => frame.payload.case === "heartbeat");
    expect(heartbeat?.payload.case).toBe("heartbeat");
    if (heartbeat?.payload.case === "heartbeat") {
      expect(heartbeat.payload.value.monotonicTimeMs).toBe(20n);
      expect(heartbeat.requestId).toBe("heartbeat-1");
    }
    expect(received).toEqual([
      { kind: "steer", commandId: commandId("steer"), text: "guide" },
      { kind: "follow-up", commandId: commandId("follow-up"), text: "continue" },
      { kind: "abort", commandId: commandId("abort") },
      { kind: "compact", commandId: commandId("compact") },
      {
        kind: "set-model",
        commandId: commandId("set-model"),
        provider: "openai",
        modelId: "model-1",
      },
      {
        kind: "ui-response",
        commandId: commandId("ui-response"),
        uiRequestId: "ui-1",
        response: new TextEncoder().encode("yes"),
        displayedContentHash: new TextEncoder().encode("hash"),
      },
    ]);
  });

  test("reports command execution exceptions as COMMAND_FAILED results", async () => {
    const factory = sessionFactory(async () => {
      throw new Error("command execution failed");
    });
    const output = await runServer(
      [
        hostFrame("start", {
          case: "start",
          value: create(RuntimeStartSchema, { cwd: "/workspace", allowedTools: [] }),
        }),
        commandFrame("command-1", "steer", { text: "fail" }),
        hostFrame("shutdown", {
          case: "shutdown",
          value: create(RuntimeShutdownSchema, { reason: "done", deadlineMs: 100n }),
        }),
      ],
      factory,
    );
    const result = decodeAll(output).find(
      (frame) => frame.payload.case === "commandResult" && frame.requestId === "command-1",
    );
    expect(result?.payload.case).toBe("commandResult");
    if (result?.payload.case === "commandResult") {
      expect(result.payload.value.success).toBe(false);
      expect(result.payload.value.code).toBe("COMMAND_FAILED");
      expect(result.payload.value.message).toBe("command execution failed");
    }
  });

  test("accepts a second shutdown request on a subsequent run", async () => {
    const output: Uint8Array[] = [];
    const server = createServer(output, sessionFactory());
    const firstShutdown = hostFrame("shutdown-1", {
      case: "shutdown",
      value: create(RuntimeShutdownSchema, { reason: "done", deadlineMs: 100n }),
    });
    const secondShutdown = hostFrame("shutdown-2", {
      case: "shutdown",
      value: create(RuntimeShutdownSchema, { reason: "again", deadlineMs: 100n }),
    });

    await server.run(chunks([firstShutdown]));
    await server.run(chunks([secondShutdown]));

    expect(decodeAll(output).map((frame) => frame.payload.case)).toEqual([
      "hello",
      "snapshot",
      "hello",
    ]);
  });

  test("faults on invalid command kinds and payloads", async () => {
    const cases = [
      commandFrame("unknown", "unknown", {}),
      commandFrame("thinking", "set-thinking", { level: "impossible" }),
      commandFrame("array", "steer", ["not", "an", "object"]),
      commandFrame("allow", "approval-response", {
        approvalRequestId: "approval-1",
        allow: "yes",
        displayedContentHash: "aGFzaA==",
      }),
    ];

    await Promise.all(
      cases.map(async (frame) => {
        const output = await runExpectFault([
          hostFrame("start", {
            case: "start",
            value: create(RuntimeStartSchema, { cwd: "/workspace", allowedTools: [] }),
          }),
          frame,
        ]);
        expect(decodeAll(output).at(-1)?.payload.case).toBe("fault");
      }),
    );
  });

  test("faults on invalid command sequence, direction, and shutdown request id", async () => {
    const start = hostFrame("start", {
      case: "start",
      value: create(RuntimeStartSchema, { cwd: "/workspace", allowedTools: [] }),
    });
    const commandBeforeStart = commandFrame("command", "steer", { text: "early" });
    const startTwice = hostFrame("start-2", {
      case: "start",
      value: create(RuntimeStartSchema, { cwd: "/workspace", allowedTools: [] }),
    });
    const hostHello = hostFrame(undefined, {
      case: "hello",
      value: create(RuntimeHelloSchema, {}),
    });
    const shutdownWithoutRequestId = hostFrame(undefined, {
      case: "shutdown",
      value: create(RuntimeShutdownSchema, { reason: "done", deadlineMs: 100n }),
    });

    await Promise.all(
      [[commandBeforeStart], [start, startTwice], [hostHello], [shutdownWithoutRequestId]].map(
        async (frames) => {
          const output = await runExpectFault(frames);
          expect(decodeAll(output).at(-1)?.payload.case).toBe("fault");
        },
      ),
    );
  });
});

function commandFrame(command: string, kind: string, payload: unknown): RuntimeFrame {
  return hostFrame(command, {
    case: "command",
    value: create(RuntimeCommandSchema, {
      commandId: commandId(command),
      kind,
      payload: new TextEncoder().encode(JSON.stringify(payload)),
    }),
  });
}

function hostFrame(requestId: string | undefined, payload: RuntimeFrame["payload"]): RuntimeFrame {
  return create(RuntimeFrameSchema, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeGeneration,
    ...(requestId === undefined ? {} : { requestId }),
    createdAtMs: 1n,
    payload,
  });
}

function createServer(output: Uint8Array[], factory: AgentSessionFactory): RuntimeFrameServer {
  return new RuntimeFrameServer(
    {
      runtimeId,
      runtimeGeneration,
      nowMs: () => 10n,
      monotonicMs: () => 20n,
      factory: async () => factory,
    },
    { write: async (bytes) => void output.push(bytes) },
  );
}

async function runServer(
  frames: readonly RuntimeFrame[],
  factory = sessionFactory(),
): Promise<Uint8Array[]> {
  const output: Uint8Array[] = [];
  await createServer(output, factory).run(chunks(frames));
  return output;
}

async function runExpectFault(frames: readonly RuntimeFrame[]): Promise<Uint8Array[]> {
  const output: Uint8Array[] = [];
  await expect(createServer(output, sessionFactory()).run(chunks(frames))).rejects.toThrow();
  return output;
}

function sessionFactory(execute: (command: AgentCommand) => Promise<void> = async () => undefined) {
  const session: AgentSessionPort = {
    sessionId: sessionId("session-test"),
    capabilities: {
      sdkVersion: "1",
      sessionPersistence: true,
      extensionUiKinds: [],
      tools: [],
      steering: true,
      followUp: true,
      compaction: true,
      subagents: false,
      mcp: false,
      lsp: false,
    },
    execute,
    events: emptyEvents,
    flush: async () => "fingerprint",
    dispose: async () => undefined,
  };
  const factory: AgentSessionFactory = { create: async () => session };
  return factory;
}

async function* emptyEvents(): AsyncIterable<never> {}

async function* chunks(frames: readonly RuntimeFrame[]): AsyncIterable<Uint8Array> {
  yield concatenate(frames.map(encodeRuntimeFrame));
}

function concatenate(values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((size, value) => size + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function decodeAll(encoded: readonly Uint8Array[]): RuntimeFrame[] {
  const decoder = new RuntimeFrameDecoder();
  const frames = encoded.flatMap((chunk) => decoder.push(chunk));
  decoder.finish();
  return frames;
}

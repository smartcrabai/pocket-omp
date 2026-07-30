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
  type RuntimeFrame,
  RuntimeFrameSchema,
  RuntimeShutdownSchema,
  RuntimeStartSchema,
} from "@pocket-omp/proto/runtime/v1";

import { RuntimeFrameServer } from "../src/runtime-server";

const runtimeId = "runtime-test";
const runtimeGeneration = 7n;

describe("RuntimeFrameServer", () => {
  test("serves start, command, event, and shutdown over framed protobuf", async () => {
    const commands: AgentCommand[] = [];
    let disposed = false;
    const session: AgentSessionPort = {
      sessionId: sessionId("session-test"),
      capabilities: {
        sdkVersion: "17.1.5",
        sessionFormatVersion: "1",
        sessionPersistence: true,
        extensionUiKinds: [],
        tools: ["read"],
        steering: true,
        followUp: true,
        compaction: true,
        subagents: true,
        mcp: true,
        lsp: true,
      },
      execute: async (command) => {
        commands.push(command);
      },
      events: () => emptyEvents(),
      flush: async () => "aabb",
      dispose: async () => {
        disposed = true;
      },
    };
    const factory: AgentSessionFactory = { create: async () => session };
    const output: Uint8Array[] = [];
    const server = new RuntimeFrameServer(
      {
        runtimeId,
        runtimeGeneration,
        nowMs: () => 100n,
        monotonicMs: () => 50n,
        factory: async () => factory,
      },
      { write: async (bytes) => output.push(bytes) },
    );
    const frames = [
      hostFrame("start-1", {
        case: "start",
        value: create(RuntimeStartSchema, {
          cwd: "/workspace",
          sessionPath: "/sessions/session.jsonl",
          allowedTools: ["read"],
        }),
      }),
      hostFrame("command-1", {
        case: "command",
        value: create(RuntimeCommandSchema, {
          commandId: commandId("command-1"),
          kind: "submit-prompt",
          payload: new TextEncoder().encode(JSON.stringify({ text: "hello" })),
        }),
      }),
      hostFrame("command-2", {
        case: "command",
        value: create(RuntimeCommandSchema, {
          commandId: commandId("command-2"),
          kind: "approval-response",
          payload: new TextEncoder().encode(
            JSON.stringify({
              approvalRequestId: "approval-1",
              allow: true,
              displayedContentHash: "AA==",
            }),
          ),
        }),
      }),
      hostFrame("command-3", {
        case: "command",
        value: create(RuntimeCommandSchema, {
          commandId: commandId("command-3"),
          kind: "set-thinking",
          payload: new TextEncoder().encode(JSON.stringify({ level: "high" })),
        }),
      }),
      hostFrame("shutdown-1", {
        case: "shutdown",
        value: create(RuntimeShutdownSchema, { reason: "test", deadlineMs: 1_000n }),
      }),
    ].map(encodeRuntimeFrame);

    await server.run(chunks(concatenate(frames), [1, 3, 11, 29]));

    const decoded = decodeAll(output);
    expect(decoded.map((frame) => frame.payload.case)).toEqual([
      "hello",
      "ready",
      "commandAccepted",
      "commandResult",
      "commandAccepted",
      "commandResult",
      "commandAccepted",
      "commandResult",
      "snapshot",
    ]);
    expect(decoded[1]?.requestId).toBe("start-1");
    expect(decoded[2]?.requestId).toBe("command-1");
    expect(decoded[4]?.requestId).toBe("command-2");
    expect(decoded[6]?.requestId).toBe("command-3");
    expect(decoded[8]?.requestId).toBe("shutdown-1");
    expect(commands).toEqual([
      { kind: "submit-prompt", commandId: commandId("command-1"), text: "hello" },
      {
        kind: "approval-response",
        commandId: commandId("command-2"),
        approvalRequestId: "approval-1",
        allow: true,
        displayedContentHash: new Uint8Array([0]),
      },
      {
        kind: "set-thinking",
        commandId: commandId("command-3"),
        level: "high",
      },
    ]);
    expect(disposed).toBe(true);
  });

  test("faults and exits on a stale runtime generation", async () => {
    const output: Uint8Array[] = [];
    const server = new RuntimeFrameServer(
      {
        runtimeId,
        runtimeGeneration,
        nowMs: () => 100n,
        monotonicMs: () => 50n,
        factory: async () => ({ create: async () => Promise.reject(new Error("unused")) }),
      },
      { write: async (bytes) => output.push(bytes) },
    );
    const stale = create(RuntimeFrameSchema, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId,
      runtimeGeneration: runtimeGeneration - 1n,
      requestId: "shutdown",
      createdAtMs: 1n,
      payload: {
        case: "shutdown",
        value: create(RuntimeShutdownSchema, { reason: "test", deadlineMs: 1_000n }),
      },
    });

    await expect(server.run(chunks(encodeRuntimeFrame(stale), []))).rejects.toThrow(
      "Runtime frame fence does not match process",
    );
    expect(decodeAll(output).map((frame) => frame.payload.case)).toEqual(["hello", "fault"]);
  });
});

function hostFrame(requestId: string, payload: RuntimeFrame["payload"]): RuntimeFrame {
  return create(RuntimeFrameSchema, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeGeneration,
    requestId,
    createdAtMs: 1n,
    payload,
  });
}

async function* emptyEvents(): AsyncIterable<never> {}

async function* chunks(bytes: Uint8Array, cuts: readonly number[]): AsyncIterable<Uint8Array> {
  let offset = 0;
  for (const size of cuts) {
    yield bytes.slice(offset, offset + size);
    offset += size;
  }
  yield bytes.slice(offset);
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

function decodeAll(encodedChunks: readonly Uint8Array[]): RuntimeFrame[] {
  const decoder = new RuntimeFrameDecoder();
  const frames = encodedChunks.flatMap((chunk) => decoder.push(chunk));
  decoder.finish();
  return frames;
}

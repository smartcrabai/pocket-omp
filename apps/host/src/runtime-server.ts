import { create } from "@bufbuild/protobuf";
import {
  approvalRequestId,
  type AgentCommand,
  commandId,
  type OmpCapabilityManifest as DomainCapabilities,
  uiRequestId,
} from "@pocket-omp/agent-domain";
import {
  AgentRuntimeApplication,
  type AgentSessionFactory,
  type AgentSessionPort,
} from "@pocket-omp/agent-runtime-core";
import {
  decodeRuntimeLogicalMessage,
  encodeRuntimeMessage,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeChunkAssembler,
  RuntimeFrameDecoder,
} from "@pocket-omp/agent-runtime-protocol";
import {
  OmpCapabilityManifestSchema,
  RuntimeCommandAcceptedSchema,
  RuntimeCommandResultSchema,
  RuntimeEventSchema,
  type RuntimeFrame,
  RuntimeFrameSchema,
  RuntimeHeartbeatSchema,
  RuntimeHelloSchema,
  RuntimeReadySchema,
  RuntimeSnapshotSchema,
} from "@pocket-omp/proto/runtime/v1";

import { OMP_VERSION, RELEASE_VERSION } from "./shared";

export interface RuntimeFrameSink {
  write(bytes: Uint8Array): Promise<void>;
}

export interface RuntimeServerOptions {
  readonly runtimeId: string;
  readonly runtimeGeneration: bigint;
  readonly nowMs: () => bigint;
  readonly monotonicMs: () => bigint;
  readonly factory: () => Promise<AgentSessionFactory>;
}

export class RuntimeFrameServer {
  readonly #options: RuntimeServerOptions;
  readonly #sink: RuntimeFrameSink;
  readonly #chunkAssembler = new RuntimeChunkAssembler();
  #application: AgentRuntimeApplication | undefined;
  #eventSequence = 0n;
  #writeTail = Promise.resolve();
  #stopping = false;

  public constructor(options: RuntimeServerOptions, sink: RuntimeFrameSink) {
    if (options.runtimeGeneration === 0n || options.runtimeId.length === 0) {
      throw new RuntimeServerError("INVALID_FENCE", "Runtime identity and generation are required");
    }
    this.#options = options;
    this.#sink = sink;
  }

  public async run(chunks: AsyncIterable<Uint8Array>): Promise<void> {
    await this.#send({
      case: "hello",
      value: create(RuntimeHelloSchema, {
        runtimeVersion: RELEASE_VERSION,
        sdkVersion: OMP_VERSION,
        minimumProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        maximumProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      }),
    });
    const decoder = new RuntimeFrameDecoder();
    try {
      for await (const chunk of chunks) {
        for (const physicalFrame of decoder.push(chunk)) {
          const frame = this.#logicalFrame(physicalFrame);
          if (frame === undefined) continue;
          // oxlint-disable-next-line no-await-in-loop -- RuntimeFrame order is the protocol contract.
          if (await this.#handle(frame)) return;
        }
      }
      decoder.finish();
      if (this.#application?.lifecycle.kind === "ready") await this.#application.shutdown();
    } catch (error) {
      await this.#fault(error);
      throw error;
    }
  }

  #logicalFrame(frame: RuntimeFrame): RuntimeFrame | undefined {
    if (
      frame.runtimeId !== this.#options.runtimeId ||
      frame.runtimeGeneration !== this.#options.runtimeGeneration
    ) {
      throw new RuntimeServerError("FENCE_MISMATCH", "Runtime frame fence does not match process");
    }
    if (frame.payload.case !== "chunk") return frame;
    const bytes = this.#chunkAssembler.accept(frame.payload.value);
    return bytes === undefined ? undefined : decodeRuntimeLogicalMessage(bytes);
  }

  async #handle(frame: RuntimeFrame): Promise<boolean> {
    if (
      frame.runtimeId !== this.#options.runtimeId ||
      frame.runtimeGeneration !== this.#options.runtimeGeneration
    ) {
      throw new RuntimeServerError("FENCE_MISMATCH", "Runtime frame fence does not match process");
    }
    switch (frame.payload.case) {
      case "start":
        await this.#start(frame.requestId, frame.payload.value);
        return false;
      case "command":
        await this.#command(frame.requestId, frame.payload.value);
        return false;
      case "heartbeat":
        await this.#send(
          {
            case: "heartbeat",
            value: create(RuntimeHeartbeatSchema, {
              monotonicTimeMs: this.#options.monotonicMs(),
            }),
          },
          frame.requestId,
        );
        return false;
      case "shutdown": {
        if (this.#stopping) return true;
        if (frame.requestId === undefined) {
          throw new RuntimeServerError("COMMAND_STATE", "Runtime shutdown request is missing");
        }
        this.#stopping = true;
        const fingerprint =
          this.#application?.lifecycle.kind === "ready" ? await this.#application.shutdown() : "";
        await this.#send(
          {
            case: "snapshot",
            value: create(RuntimeSnapshotSchema, {
              stateHash: /^[0-9a-f]{64}$/i.test(fingerprint)
                ? Uint8Array.from(Buffer.from(fingerprint, "hex"))
                : new TextEncoder().encode(fingerprint),
            }),
          },
          frame.requestId,
        );
        await this.#writeTail;
        return true;
      }
      case "hello":
      case "ready":
      case "commandAccepted":
      case "commandResult":
      case "event":
      case "snapshot":
      case "fault":
      case "chunk":
        throw new RuntimeServerError("DIRECTION", `Host sent runtime-owned ${frame.payload.case}`);
      default:
        throw new RuntimeServerError("MALFORMED", "Runtime frame payload is missing");
    }
  }

  async #start(
    requestId: string | undefined,
    input: { cwd: string; sessionPath?: string; allowedTools: string[] },
  ): Promise<void> {
    if (requestId === undefined || this.#application !== undefined) {
      throw new RuntimeServerError("START_STATE", "Runtime start request is missing or duplicated");
    }
    const application = new AgentRuntimeApplication(await this.#options.factory());
    this.#application = application;
    const session = await application.start({
      cwd: input.cwd,
      ...(input.sessionPath === undefined ? {} : { sessionPath: input.sessionPath }),
      allowedTools: input.allowedTools,
    });
    const fingerprint = await session.flush();
    await this.#send(
      {
        case: "ready",
        value: create(RuntimeReadySchema, {
          capabilities: capabilities(session.capabilities),
          sessionId: session.sessionId,
          sessionFingerprint: fingerprint,
        }),
      },
      requestId,
    );
    void this.#forwardEvents(session).catch((error: unknown) => this.#fault(error));
  }

  async #command(
    requestId: string | undefined,
    input: { commandId: string; kind: string; payload: Uint8Array },
  ): Promise<void> {
    if (requestId === undefined || this.#application?.lifecycle.kind !== "ready") {
      throw new RuntimeServerError("COMMAND_STATE", "Runtime command arrived before ready");
    }
    const command = decodeCommand(input);
    await this.#send(
      {
        case: "commandAccepted",
        value: create(RuntimeCommandAcceptedSchema, { commandId: input.commandId }),
      },
      requestId,
    );
    try {
      const result = await this.#application.accept(command);
      await this.#send(
        {
          case: "commandResult",
          value: create(RuntimeCommandResultSchema, {
            commandId: input.commandId,
            success: true,
            code: result.duplicate ? "DUPLICATE" : "OK",
            message: result.duplicate ? "Command was already accepted" : "Command completed",
          }),
        },
        requestId,
      );
    } catch (error) {
      await this.#send(
        {
          case: "commandResult",
          value: create(RuntimeCommandResultSchema, {
            commandId: input.commandId,
            success: false,
            code: "COMMAND_FAILED",
            message: error instanceof Error ? error.message : String(error),
          }),
        },
        requestId,
      );
    }
  }

  async #forwardEvents(session: AgentSessionPort): Promise<void> {
    for await (const event of session.events()) {
      this.#eventSequence += 1n;
      await this.#send(
        {
          case: "event",
          value: create(RuntimeEventSchema, {
            eventId: event.eventId,
            kind: event.kind,
            payload: new TextEncoder().encode(JSON.stringify(event, jsonReplacer)),
          }),
        },
        undefined,
        this.#eventSequence,
      );
    }
  }

  async #fault(error: unknown): Promise<void> {
    try {
      await this.#send({
        case: "fault",
        value: {
          $typeName: "pocket.omp.runtime.v1.RuntimeFault",
          code: error instanceof RuntimeServerError ? error.code : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
          processMustExit: true,
        },
      });
    } catch {
      // The original protocol failure is more useful than a secondary write failure.
    }
  }

  async #send(
    payload: RuntimeFrame["payload"],
    requestId?: string,
    eventSequence?: bigint,
  ): Promise<void> {
    if (payload.case === undefined) {
      throw new RuntimeServerError("MALFORMED", "Cannot send an empty RuntimeFrame");
    }
    const frames = encodeRuntimeMessage(
      create(RuntimeFrameSchema, {
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        runtimeId: this.#options.runtimeId,
        runtimeGeneration: this.#options.runtimeGeneration,
        ...(requestId === undefined ? {} : { requestId }),
        ...(eventSequence === undefined ? {} : { eventSequence }),
        createdAtMs: this.#options.nowMs(),
        payload,
      }),
    );
    const write = this.#writeTail.then(async () => {
      for (const bytes of frames) {
        // oxlint-disable-next-line no-await-in-loop -- Chunks must be written in sequence.
        await this.#sink.write(bytes);
      }
      return undefined;
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }
}

function capabilities(value: DomainCapabilities) {
  return create(OmpCapabilityManifestSchema, {
    sdkVersion: value.sdkVersion,
    ...(value.sessionFormatVersion === undefined
      ? {}
      : { sessionFormatVersion: value.sessionFormatVersion }),
    sessionPersistence: value.sessionPersistence,
    extensionUiKinds: [...value.extensionUiKinds],
    tools: [...value.tools],
    steering: value.steering,
    followUp: value.followUp,
    compaction: value.compaction,
    subagents: value.subagents,
    mcp: value.mcp,
    lsp: value.lsp,
  });
}

function decodeCommand(input: {
  commandId: string;
  kind: string;
  payload: Uint8Array;
}): AgentCommand {
  const id = commandId(input.commandId);
  const payload = jsonObject(input.payload);
  switch (input.kind) {
    case "submit-prompt":
    case "steer":
    case "follow-up":
      return { kind: input.kind, commandId: id, text: stringField(payload, "text") };
    case "abort":
    case "compact":
      return { kind: input.kind, commandId: id };
    case "set-model":
      return {
        kind: input.kind,
        commandId: id,
        provider: stringField(payload, "provider"),
        modelId: stringField(payload, "modelId"),
      };
    case "set-thinking": {
      const level = stringField(payload, "level");
      if (!isThinkingLevel(level)) {
        throw new RuntimeServerError("COMMAND_PAYLOAD", "Invalid thinking level");
      }
      return { kind: input.kind, commandId: id, level };
    }
    case "approval-response":
      return {
        kind: input.kind,
        commandId: id,
        approvalRequestId: approvalRequestId(stringField(payload, "approvalRequestId")),
        allow: booleanField(payload, "allow"),
        displayedContentHash: base64Field(payload, "displayedContentHash"),
      };
    case "ui-response":
      return {
        kind: input.kind,
        commandId: id,
        uiRequestId: uiRequestId(stringField(payload, "uiRequestId")),
        response: base64Field(payload, "response"),
        displayedContentHash: base64Field(payload, "displayedContentHash"),
      };
    default:
      throw new RuntimeServerError("COMMAND_KIND", `Unsupported command kind ${input.kind}`);
  }
}

type ThinkingLevel = Extract<AgentCommand, { readonly kind: "set-thinking" }>["level"];

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function jsonObject(bytes: Uint8Array): object {
  if (bytes.byteLength === 0) return {};
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeServerError("COMMAND_PAYLOAD", "Command payload must be a JSON object");
  }
  return value;
}

function stringField(value: object, name: string): string {
  const field = Reflect.get(value, name);
  if (typeof field !== "string") {
    throw new RuntimeServerError("COMMAND_PAYLOAD", `${name} must be a string`);
  }
  return field;
}

function booleanField(value: object, name: string): boolean {
  const field = Reflect.get(value, name);
  if (typeof field !== "boolean") {
    throw new RuntimeServerError("COMMAND_PAYLOAD", `${name} must be a boolean`);
  }
  return field;
}

function base64Field(value: object, name: string): Uint8Array {
  return Uint8Array.from(Buffer.from(stringField(value, name), "base64"));
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64") };
  return value;
}

export class RuntimeServerError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_FENCE"
      | "FENCE_MISMATCH"
      | "DIRECTION"
      | "MALFORMED"
      | "START_STATE"
      | "COMMAND_STATE"
      | "COMMAND_KIND"
      | "COMMAND_PAYLOAD",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeServerError";
  }
}

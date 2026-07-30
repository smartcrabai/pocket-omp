import { create } from "@bufbuild/protobuf";
import { RuntimeProcessClient } from "@pocket-omp/agent-runtime-client";
import { RUNTIME_PROTOCOL_VERSION } from "@pocket-omp/agent-runtime-protocol";
import {
  HostLocalErrorSchema,
  type HostLocalFrame,
  PrepareTuiHandoffResponseSchema,
  TuiExitedRequestSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import {
  RuntimeCommandSchema,
  type RuntimeFrame,
  RuntimeFrameSchema,
  RuntimeShutdownSchema,
  RuntimeStartSchema,
} from "@pocket-omp/proto/runtime/v1";

import {
  LocalControlError,
  type LocalControlPaths,
  LocalControlServer,
  localControlPaths,
} from "./local-control";
import { OMP_VERSION } from "./shared";

interface RuntimeConnection {
  readonly client: RuntimeProcessClient;
  readonly frames: AsyncIterator<RuntimeFrame>;
  readonly runtimeId: string;
  readonly generation: bigint;
  readonly sessionId: string;
}

interface HandoffState {
  readonly ticket: string;
  readonly expiresAtMs: bigint;
}

export interface HostDaemonOptions {
  readonly cwd: string;
  readonly sessionPath: string;
  readonly runtimeArguments?: readonly string[];
  readonly runtimeExecutable: string;
  readonly paths?: LocalControlPaths;
  readonly nowMs?: () => bigint;
}

export class HostDaemon implements AsyncDisposable {
  readonly #options: HostDaemonOptions;
  readonly #nowMs: () => bigint;
  #runtime: RuntimeConnection;
  #control: LocalControlServer | undefined;
  #handoff: HandoffState | undefined;
  #generation: bigint;

  private constructor(options: HostDaemonOptions, runtime: RuntimeConnection) {
    this.#options = options;
    this.#nowMs = options.nowMs ?? (() => BigInt(Date.now()));
    this.#runtime = runtime;
    this.#generation = runtime.generation;
  }

  public static async start(options: HostDaemonOptions): Promise<HostDaemon> {
    const runtime = await startRuntime(options, 1n);
    const daemon = new HostDaemon(options, runtime);
    daemon.#control = await LocalControlServer.start({
      paths: options.paths ?? localControlPaths(),
      secret: crypto.getRandomValues(new Uint8Array(32)),
      handler: async (request) => daemon.#handle(request),
    });
    return daemon;
  }

  public get sessionId(): string {
    return this.#runtime.sessionId;
  }

  public async close(): Promise<void> {
    await this.#control?.close();
    this.#control = undefined;
    try {
      await shutdownRuntime(this.#runtime, "Host Daemon shutdown");
    } catch {
      await this.#runtime.client[Symbol.asyncDispose]();
    }
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  async #handle(request: HostLocalFrame): Promise<HostLocalFrame["body"]> {
    switch (request.body.case) {
      case "prepareTuiHandoff":
        return this.#prepare(request.body.value.sessionId, request.body.value.abortActiveRun);
      case "tuiExited":
        return this.#tuiExited(
          request.body.value.handoffTicket,
          request.body.value.exitCode,
          request.body.value.finalFileFingerprint,
        );
      default:
        return {
          case: "error",
          value: create(HostLocalErrorSchema, {
            code: "DIRECTION",
            message: "Unsupported client local-control message",
          }),
        };
    }
  }

  async #prepare(sessionId: string, abortActiveRun: boolean): Promise<HostLocalFrame["body"]> {
    if (this.#handoff !== undefined) {
      throw new LocalControlError("HANDOFF", "A TUI handoff is already active");
    }
    if (sessionId !== this.#runtime.sessionId) {
      throw new LocalControlError("SESSION", "Session is not owned by this Host Daemon");
    }
    if (abortActiveRun) await abortRuntime(this.#runtime);
    const fingerprint = await shutdownRuntime(this.#runtime, "Transfer ownership to OMP TUI");
    const ticket = crypto.randomUUID();
    const expiresAtMs = this.#nowMs() + 30_000n;
    this.#handoff = { ticket, expiresAtMs };
    return {
      case: "handoffReady",
      value: create(PrepareTuiHandoffResponseSchema, {
        handoffTicket: ticket,
        sessionPath: this.#options.sessionPath,
        cwd: this.#options.cwd,
        tuiVersion: OMP_VERSION,
        fileFingerprint: fingerprint,
        expiresAtMs,
      }),
    };
  }

  async #tuiExited(
    ticket: string,
    exitCode: number,
    finalFileFingerprint: Uint8Array,
  ): Promise<HostLocalFrame["body"]> {
    const handoff = this.#handoff;
    if (handoff === undefined || handoff.ticket !== ticket || handoff.expiresAtMs < this.#nowMs()) {
      throw new LocalControlError("HANDOFF", "TUI handoff ticket is invalid or expired");
    }
    const actualFingerprint = await sha256File(this.#options.sessionPath);
    if (!constantTimeEqual(actualFingerprint, finalFileFingerprint)) {
      throw new LocalControlError("HANDOFF", "TUI final session fingerprint does not match disk");
    }
    this.#generation += 1n;
    this.#runtime = await startRuntime(this.#options, this.#generation);
    this.#handoff = undefined;
    return {
      case: "tuiExited",
      value: create(TuiExitedRequestSchema, {
        handoffTicket: ticket,
        exitCode,
        finalFileFingerprint: actualFingerprint,
      }),
    };
  }
}

async function startRuntime(
  options: HostDaemonOptions,
  generation: bigint,
): Promise<RuntimeConnection> {
  const runtimeId = crypto.randomUUID();
  const environment = runtimeEnvironment(runtimeId, generation);
  const client = RuntimeProcessClient.spawn({
    executable: options.runtimeExecutable,
    ...(options.runtimeArguments === undefined ? {} : { arguments: options.runtimeArguments }),
    cwd: options.cwd,
    environment,
    allowedEnvironmentNames: new Set(Object.keys(environment)),
  });
  const frames = client.events()[Symbol.asyncIterator]();
  let hello: RuntimeFrame;
  try {
    hello = await nextFrame(frames, "hello");
  } catch (error) {
    const stderr = await client.stderr();
    throw new HostDaemonError(
      "RUNTIME",
      `${error instanceof Error ? error.message : String(error)}; exit=${client.exitCode ?? "running"}${stderr.length === 0 ? "" : `: ${stderr.trim()}`}`,
    );
  }
  if (
    hello.payload.case !== "hello" ||
    hello.payload.value.minimumProtocolVersion > RUNTIME_PROTOCOL_VERSION ||
    hello.payload.value.maximumProtocolVersion < RUNTIME_PROTOCOL_VERSION
  ) {
    await client[Symbol.asyncDispose]();
    throw new HostDaemonError("PROTOCOL", "Agent Runtime protocol versions do not overlap");
  }
  const requestId = crypto.randomUUID();
  await client.send(
    create(RuntimeFrameSchema, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId,
      runtimeGeneration: generation,
      requestId,
      createdAtMs: BigInt(Date.now()),
      payload: {
        case: "start",
        value: create(RuntimeStartSchema, {
          cwd: options.cwd,
          sessionPath: options.sessionPath,
          allowedTools: [],
        }),
      },
    }),
  );
  const ready = await nextFrame(frames, "ready", requestId);
  if (ready.payload.case !== "ready")
    throw new HostDaemonError("PROTOCOL", "Runtime did not ready");
  return {
    client,
    frames,
    runtimeId,
    generation,
    sessionId: ready.payload.value.sessionId,
  };
}

async function abortRuntime(runtime: RuntimeConnection): Promise<void> {
  const requestId = crypto.randomUUID();
  await runtime.client.send(
    create(RuntimeFrameSchema, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
      requestId,
      createdAtMs: BigInt(Date.now()),
      payload: {
        case: "command",
        value: create(RuntimeCommandSchema, {
          commandId: crypto.randomUUID(),
          kind: "abort",
        }),
      },
    }),
  );
  await nextFrame(runtime.frames, "commandAccepted", requestId);
  const result = await nextFrame(runtime.frames, "commandResult", requestId);
  if (result.payload.case !== "commandResult" || !result.payload.value.success) {
    throw new HostDaemonError("RUNTIME", "Agent Runtime rejected abort command");
  }
}

async function shutdownRuntime(runtime: RuntimeConnection, reason: string): Promise<Uint8Array> {
  const requestId = crypto.randomUUID();
  await runtime.client.send(
    create(RuntimeFrameSchema, {
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      runtimeId: runtime.runtimeId,
      runtimeGeneration: runtime.generation,
      requestId,
      createdAtMs: BigInt(Date.now()),
      payload: {
        case: "shutdown",
        value: create(RuntimeShutdownSchema, {
          reason,
          deadlineMs: BigInt(Date.now() + 5_000),
        }),
      },
    }),
  );
  const snapshot = await nextFrame(runtime.frames, "snapshot", requestId);
  const exitCode = await runtime.client.stop(5_000);
  if (exitCode !== 0 || snapshot.payload.case !== "snapshot") {
    throw new HostDaemonError("RUNTIME", `Agent Runtime shutdown failed with exit ${exitCode}`);
  }
  return snapshot.payload.value.stateHash;
}

async function nextFrame(
  frames: AsyncIterator<RuntimeFrame>,
  expectedCase: Exclude<RuntimeFrame["payload"]["case"], undefined>,
  requestId?: string,
): Promise<RuntimeFrame> {
  const timeout = Promise.withResolvers<undefined>();
  const timer = setTimeout(timeout.resolve, 10_000);
  try {
    const result = await Promise.race([
      nextMatchingFrame(frames, expectedCase, requestId),
      timeout.promise,
    ]);
    if (result === undefined) {
      throw new HostDaemonError("TIMEOUT", `Timed out waiting for Runtime ${expectedCase}`);
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function nextMatchingFrame(
  frames: AsyncIterator<RuntimeFrame>,
  expectedCase: Exclude<RuntimeFrame["payload"]["case"], undefined>,
  requestId?: string,
): Promise<RuntimeFrame> {
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- Runtime response order is sequential.
    const result = await frames.next();
    if (result.done) throw new HostDaemonError("RUNTIME", "Agent Runtime stream ended");
    const frame = result.value;
    if (frame.payload.case === "fault") {
      throw new HostDaemonError(
        "RUNTIME",
        `${frame.payload.value.code}: ${frame.payload.value.message}`,
      );
    }
    if (
      frame.payload.case === expectedCase &&
      (requestId === undefined || frame.requestId === requestId)
    ) {
      return frame;
    }
  }
}

function runtimeEnvironment(runtimeId: string, generation: bigint): Record<string, string> {
  const names = [
    "HOME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "USER",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "POCKET_OMP_AGENT_DIR",
  ];
  const environment: Record<string, string> = {
    POCKET_OMP_RUNTIME_ID: runtimeId,
    POCKET_OMP_RUNTIME_GENERATION: generation.toString(),
  };
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
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

export class HostDaemonError extends Error {
  public constructor(
    public readonly code: "PROTOCOL" | "RUNTIME" | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "HostDaemonError";
  }
}

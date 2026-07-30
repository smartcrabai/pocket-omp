import {
  decodeRuntimeLogicalMessage,
  encodeRuntimeMessage,
  RuntimeChunkAssembler,
  RuntimeFrameDecoder,
  RuntimeProtocolError,
} from "@pocket-omp/agent-runtime-protocol";
import type { RuntimeFrame } from "@pocket-omp/proto/runtime/v1";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

export interface SpawnRuntimeOptions {
  readonly executable: string;
  readonly arguments?: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly allowedEnvironmentNames: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

export class RuntimeProcessClient implements AsyncDisposable {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #frames = new AsyncFrameQueue();
  #writeTail = Promise.resolve();
  readonly #reader: Promise<void>;
  readonly #stderr: Promise<string>;
  readonly #exited: Promise<number>;

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.#process = process;
    this.#reader = this.#readFrames();
    this.#stderr = readText(process.stderr);
    const { promise, resolve } = Promise.withResolvers<number>();
    this.#exited = promise;
    process.once("exit", (code) => resolve(code ?? 1));
  }

  public static spawn(options: SpawnRuntimeOptions): RuntimeProcessClient {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.environment)) {
      if (options.allowedEnvironmentNames.has(name)) environment[name] = value;
    }
    const process = spawn(options.executable, [...(options.arguments ?? [])], {
      cwd: options.cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return new RuntimeProcessClient(process);
  }

  public get pid(): number {
    if (this.#process.pid === undefined) {
      throw new RuntimeProcessError("PROCESS_EXITED", "Agent Runtime did not start");
    }
    return this.#process.pid;
  }

  public get exitCode(): number | null {
    return this.#process.exitCode;
  }

  public async send(frame: RuntimeFrame): Promise<void> {
    if (this.#process.exitCode !== null || this.#process.stdin.destroyed) {
      throw new RuntimeProcessError("PROCESS_EXITED", "Agent Runtime already exited");
    }
    const frames = encodeRuntimeMessage(frame);
    const write = this.#writeTail.then(async () => {
      for (const bytes of frames) {
        if (!this.#process.stdin.write(bytes)) {
          // oxlint-disable-next-line no-await-in-loop -- Runtime chunks must preserve process order.
          await once(this.#process.stdin, "drain");
        }
      }
      return undefined;
    });
    this.#writeTail = write.catch(() => undefined);
    await write;
  }

  public events(): AsyncIterable<RuntimeFrame> {
    return this.#frames;
  }

  public stderr(): Promise<string> {
    return this.#stderr;
  }

  public async stop(deadlineMs: number): Promise<number> {
    await this.#writeTail;
    this.#process.stdin.end();
    const timeout = setTimeout(() => this.#process.kill("SIGKILL"), deadlineMs);
    try {
      return await this.#exited;
    } finally {
      clearTimeout(timeout);
      await this.#reader;
      await this.#stderr;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#process.exitCode === null) this.#process.kill("SIGTERM");
    await this.#exited;
    await this.#reader;
    await this.#stderr;
  }

  async #readFrames(): Promise<void> {
    const decoder = new RuntimeFrameDecoder();
    const assembler = new RuntimeChunkAssembler();
    try {
      for await (const incoming of this.#process.stdout) {
        for (const physicalFrame of decoder.push(incoming)) {
          if (physicalFrame.payload.case !== "chunk") {
            this.#frames.push(physicalFrame);
            continue;
          }
          const bytes = assembler.accept(physicalFrame.payload.value);
          if (bytes !== undefined) this.#frames.push(decodeRuntimeLogicalMessage(bytes));
        }
      }
      decoder.finish();
      this.#frames.close();
    } catch (error) {
      if (this.#process.exitCode === null) this.#process.kill("SIGKILL");
      this.#frames.fail(
        error instanceof RuntimeProtocolError
          ? error
          : new RuntimeProcessError("READ_FAILED", "Runtime stdout read failed", { cause: error }),
      );
    }
  }
}

class AsyncFrameQueue implements AsyncIterable<RuntimeFrame> {
  readonly #queued: RuntimeFrame[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<RuntimeFrame>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;

  public push(frame: RuntimeFrame): void {
    if (this.#closed || this.#error !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#queued.push(frame);
    else waiter.resolve({ done: false, value: frame });
  }

  public close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  public fail(error: unknown): void {
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  public [Symbol.asyncIterator](): AsyncIterator<RuntimeFrame> {
    return {
      next: async () => {
        const queued = this.#queued.shift();
        if (queued !== undefined) return { done: false, value: queued };
        if (this.#error !== undefined) throw this.#error;
        if (this.#closed) return { done: true, value: undefined };
        const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<RuntimeFrame>>();
        this.#waiters.push({ resolve, reject });
        return promise;
      },
    };
  }
}

async function readText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export class RuntimeProcessError extends Error {
  public constructor(
    public readonly code: "PROCESS_EXITED" | "READ_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeProcessError";
  }
}

import {
  encodeRuntimeFrame,
  RuntimeFrameDecoder,
  RuntimeProtocolError,
} from "@pocket-omp/agent-runtime-protocol";
import type { RuntimeFrame } from "@pocket-omp/proto/runtime/v1";

export interface SpawnRuntimeOptions {
  readonly executable: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly allowedEnvironmentNames: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

export class RuntimeProcessClient implements AsyncDisposable {
  readonly #process: Bun.PipedSubprocess;
  readonly #frames = new AsyncFrameQueue();
  readonly #reader: Promise<void>;

  private constructor(process: Bun.PipedSubprocess) {
    this.#process = process;
    this.#reader = this.#readFrames();
  }

  public static spawn(options: SpawnRuntimeOptions): RuntimeProcessClient {
    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.environment)) {
      if (options.allowedEnvironmentNames.has(name)) environment[name] = value;
    }
    const process = Bun.spawn([options.executable], {
      cwd: options.cwd,
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return new RuntimeProcessClient(process);
  }

  public get pid(): number {
    return this.#process.pid;
  }

  public async send(frame: RuntimeFrame): Promise<void> {
    if (this.#process.exitCode !== null) {
      throw new RuntimeProcessError("PROCESS_EXITED", "Agent Runtime already exited");
    }
    await this.#process.stdin.write(encodeRuntimeFrame(frame));
    await this.#process.stdin.flush();
  }

  public events(): AsyncIterable<RuntimeFrame> {
    return this.#frames;
  }

  public async stop(deadlineMs: number): Promise<number> {
    await this.#process.stdin.end();
    const timeout = setTimeout(() => this.#process.kill("SIGKILL"), deadlineMs);
    try {
      return await this.#process.exited;
    } finally {
      clearTimeout(timeout);
      await this.#reader;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#process.exitCode === null) this.#process.kill("SIGTERM");
    await this.#process.exited;
    await this.#reader;
  }

  async #readFrames(): Promise<void> {
    const decoder = new RuntimeFrameDecoder();
    try {
      const reader = this.#process.stdout.getReader();
      while (true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- stdout frames must preserve process order.
        const result = await reader.read();
        if (result.done) break;
        for (const frame of decoder.push(result.value)) this.#frames.push(frame);
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
        return new Promise<IteratorResult<RuntimeFrame>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
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

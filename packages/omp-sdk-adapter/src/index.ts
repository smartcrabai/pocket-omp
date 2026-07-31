import { ThinkingLevel as OmpThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
  createAgentSession,
  discoverAuthStorage,
  type AuthStorage,
  type AgentSession,
  type AgentSessionEvent,
  ModelRegistry,
  SessionManager,
  Settings,
  VERSION,
} from "@oh-my-pi/pi-coding-agent";
import {
  type AgentCommand,
  type AgentDomainEvent,
  eventId,
  type ThinkingLevel as DomainThinkingLevel,
  type OmpCapabilityManifest,
  runId,
  sessionId,
} from "@pocket-omp/agent-domain";
import type { AgentSessionFactory, AgentSessionPort } from "@pocket-omp/agent-runtime-core";

export * from "./session-list";

const OMP_THINKING_BY_DOMAIN: Record<
  DomainThinkingLevel,
  (typeof OmpThinkingLevel)[keyof typeof OmpThinkingLevel]
> = {
  off: OmpThinkingLevel.Off,
  minimal: OmpThinkingLevel.Minimal,
  low: OmpThinkingLevel.Low,
  medium: OmpThinkingLevel.Medium,
  high: OmpThinkingLevel.High,
  xhigh: OmpThinkingLevel.XHigh,
};

export interface OmpSdkAdapterOptions {
  readonly agentDir?: string;
  readonly runtimeGeneration: bigint;
  readonly nowMs: () => bigint;
  readonly newId: () => string;
}

export class OmpSdkSessionFactory implements AgentSessionFactory {
  private constructor(
    private readonly options: OmpSdkAdapterOptions,
    private readonly authStorage: AuthStorage,
    private readonly modelRegistry: ModelRegistry,
  ) {}

  public static async initialize(options: OmpSdkAdapterOptions): Promise<OmpSdkSessionFactory> {
    const authStorage = await discoverAuthStorage(options.agentDir);
    const modelRegistry = new ModelRegistry(authStorage);
    await modelRegistry.refresh();
    return new OmpSdkSessionFactory(options, authStorage, modelRegistry);
  }

  public async create(input: {
    readonly cwd: string;
    readonly sessionPath?: string;
    readonly allowedTools: readonly string[];
  }): Promise<AgentSessionPort> {
    const manager =
      input.sessionPath === undefined
        ? SessionManager.create(input.cwd)
        : await SessionManager.open(input.sessionPath);
    const settings = await Settings.init({
      cwd: input.cwd,
      ...(this.options.agentDir === undefined ? {} : { agentDir: this.options.agentDir }),
    });
    const result = await createAgentSession({
      cwd: input.cwd,
      sessionManager: manager,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settings,
      hasUI: true,
      toolNames: [...input.allowedTools],
      restrictToolNames: true,
    });
    if (result.session.sessionFile === undefined) {
      await result.session.dispose();
      throw new OmpSdkAdapterError("IN_MEMORY_SESSION", "OMP session is not file-backed");
    }
    return new OmpSdkSessionAdapter(
      result.session,
      this.modelRegistry,
      this.options.runtimeGeneration,
      this.options.nowMs,
      this.options.newId,
    );
  }
}

class OmpSdkSessionAdapter implements AgentSessionPort {
  public readonly sessionId;
  public readonly capabilities: OmpCapabilityManifest;
  readonly #events = new AgentEventQueue();
  readonly #unsubscribe: () => void;
  #revision = 0n;
  #disposed = false;

  public constructor(
    private readonly session: AgentSession,
    private readonly modelRegistry: ModelRegistry,
    private readonly runtimeGeneration: bigint,
    private readonly nowMs: () => bigint,
    private readonly newId: () => string,
  ) {
    this.sessionId = sessionId(session.sessionId);
    this.capabilities = {
      sdkVersion: VERSION,
      sessionPersistence: session.sessionFile !== undefined,
      extensionUiKinds: ["confirm", "select", "input", "editor"],
      tools: session.getAllToolNames(),
      steering: true,
      followUp: true,
      compaction: true,
      subagents: session.getAllToolNames().includes("task"),
      mcp: session.getAllToolNames().some((name) => name.startsWith("mcp")),
      lsp: session.getAllToolNames().includes("lsp"),
    };
    this.#unsubscribe = session.subscribe((event) => this.#onEvent(event));
  }

  public async execute(command: AgentCommand): Promise<void> {
    if (this.#disposed) throw new OmpSdkAdapterError("DISPOSED", "OMP session is disposed");
    switch (command.kind) {
      case "submit-prompt":
        await this.session.prompt(command.text);
        return;
      case "steer":
        await this.session.steer(command.text);
        return;
      case "follow-up":
        await this.session.followUp(command.text);
        return;
      case "abort":
        await this.session.abort({ reason: "Pocket OMP command" });
        return;
      case "compact":
        await this.session.compact();
        return;
      case "set-model": {
        const model = this.modelRegistry.find(command.provider, command.modelId);
        if (model === undefined) throw new OmpSdkAdapterError("MODEL_NOT_FOUND", "Model not found");
        await this.session.setModel(model, undefined, { persist: true });
        return;
      }
      case "set-thinking":
        this.session.setThinkingLevel(OMP_THINKING_BY_DOMAIN[command.level], true);
        return;
      case "approval-response":
      case "ui-response":
        throw new OmpSdkAdapterError(
          "INTERACTION_NOT_PENDING",
          "Interaction response must be resolved by RemoteExtensionUIContext",
        );
    }
  }

  public events(): AsyncIterable<AgentDomainEvent> {
    return this.#events;
  }

  public async flush(): Promise<string> {
    if (this.session.sessionFile === undefined) {
      throw new OmpSdkAdapterError("IN_MEMORY_SESSION", "OMP session is not file-backed");
    }
    await this.session.sessionManager.flush();
    const file = Bun.file(this.session.sessionFile);
    const bytes = (await file.exists()) ? await file.bytes() : new Uint8Array();
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    await this.session.dispose();
    this.#events.close();
  }

  #onEvent(event: AgentSessionEvent): void {
    try {
      const metadata = this.#metadata();
      switch (event.type) {
        case "agent_start":
          this.#events.push({ ...metadata, kind: "agent-started", runId: runId(this.newId()) });
          return;
        case "agent_end":
          this.#events.push({ ...metadata, kind: "agent-ended", runId: runId(this.newId()) });
          return;
        case "message_start":
          this.#events.push({ ...metadata, kind: "message-started", messageId: metadata.eventId });
          return;
        case "message_end":
          this.#events.push({
            ...metadata,
            kind: "message-completed",
            messageId: metadata.eventId,
          });
          return;
        case "message_update":
          if (event.assistantMessageEvent.type !== "text_delta") {
            throw new OmpSdkAdapterError(
              "UNSUPPORTED_SDK_EVENT",
              `Unsupported message update ${event.assistantMessageEvent.type}`,
            );
          }
          this.#events.push({
            ...metadata,
            kind: "message-delta",
            messageId: metadata.eventId,
            delta: event.assistantMessageEvent.delta,
          });
          return;
        case "tool_execution_start":
          this.#events.push({
            ...metadata,
            kind: "tool-started",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            display: { intent: event.intent },
          });
          return;
        case "tool_execution_update":
          this.#events.push({
            ...metadata,
            kind: "tool-updated",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            display: event.partialResult,
          });
          return;
        case "tool_execution_end":
          this.#events.push({
            ...metadata,
            kind: "tool-completed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            display: { result: event.result, isError: event.isError },
          });
          return;
        case "turn_start":
        case "turn_end":
        case "thinking_level_changed":
        case "auto_compaction_start":
        case "auto_compaction_end":
        case "auto_retry_start":
        case "auto_retry_end":
        case "retry_fallback_applied":
        case "retry_fallback_succeeded":
        case "ttsr_triggered":
        case "todo_reminder":
        case "todo_auto_clear":
        case "irc_message":
        case "notice":
        case "goal_updated":
          return;
        default: {
          const exhaustive: never = event;
          throw new OmpSdkAdapterError(
            "UNSUPPORTED_SDK_EVENT",
            `Unsupported SDK event ${String(exhaustive)}`,
          );
        }
      }
    } catch (error) {
      void this.session.abort({ reason: "Unsupported SDK event" });
      this.#events.fail(error);
    }
  }

  #metadata() {
    this.#revision += 1n;
    return {
      eventId: eventId(this.newId()),
      sessionId: this.sessionId,
      revision: this.#revision,
      createdAtMs: this.nowMs(),
      runtimeGeneration: this.runtimeGeneration,
    } as const;
  }
}

class AgentEventQueue implements AsyncIterable<AgentDomainEvent> {
  readonly #events: AgentDomainEvent[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<AgentDomainEvent>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  #closed = false;
  #error: unknown;

  public push(event: AgentDomainEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#events.push(event);
    else waiter.resolve({ done: false, value: event });
  }

  public close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  public fail(error: unknown): void {
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  public [Symbol.asyncIterator](): AsyncIterator<AgentDomainEvent> {
    return {
      next: async () => {
        const event = this.#events.shift();
        if (event !== undefined) return { done: false, value: event };
        if (this.#error !== undefined) throw this.#error;
        if (this.#closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<AgentDomainEvent>>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }
}

export class OmpSdkAdapterError extends Error {
  public constructor(
    public readonly code:
      | "IN_MEMORY_SESSION"
      | "DISPOSED"
      | "MODEL_NOT_FOUND"
      | "INTERACTION_NOT_PENDING"
      | "UNSUPPORTED_SDK_EVENT",
    message: string,
  ) {
    super(message);
    this.name = "OmpSdkAdapterError";
  }
}

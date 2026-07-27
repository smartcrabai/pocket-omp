import type {
  AgentCommand,
  AgentDomainEvent,
  CommandId,
  OmpCapabilityManifest,
  SessionId,
} from "@pocket-omp/agent-domain";

export interface AgentSessionPort {
  readonly sessionId: SessionId;
  readonly capabilities: OmpCapabilityManifest;
  execute(command: AgentCommand): Promise<void>;
  events(): AsyncIterable<AgentDomainEvent>;
  flush(): Promise<string>;
  dispose(): Promise<void>;
}

export interface AgentSessionFactory {
  create(input: {
    readonly cwd: string;
    readonly sessionPath?: string;
    readonly allowedTools: readonly string[];
  }): Promise<AgentSessionPort>;
}

export type RuntimeLifecycle =
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly session: AgentSessionPort }
  | { readonly kind: "stopping"; readonly session: AgentSessionPort }
  | { readonly kind: "stopped"; readonly finalFingerprint: string }
  | { readonly kind: "faulted"; readonly code: string };

export class AgentRuntimeApplication {
  #lifecycle: RuntimeLifecycle = { kind: "starting" };
  readonly #accepted = new Set<CommandId>();

  public constructor(private readonly factory: AgentSessionFactory) {}

  public get lifecycle(): RuntimeLifecycle {
    return this.#lifecycle;
  }

  public async start(input: {
    readonly cwd: string;
    readonly sessionPath?: string;
    readonly allowedTools: readonly string[];
  }): Promise<AgentSessionPort> {
    if (this.#lifecycle.kind !== "starting") {
      throw new RuntimeInvariantError("Runtime can only start once");
    }
    const session = await this.factory.create(input);
    if (!session.capabilities.sessionPersistence) {
      await session.dispose();
      throw new RuntimeInvariantError("Production runtime requires file-backed persistence");
    }
    this.#lifecycle = { kind: "ready", session };
    return session;
  }

  public async accept(command: AgentCommand): Promise<{ readonly duplicate: boolean }> {
    if (this.#lifecycle.kind !== "ready") throw new RuntimeInvariantError("Runtime is not ready");
    if (this.#accepted.has(command.commandId)) return { duplicate: true };
    this.#accepted.add(command.commandId);
    try {
      await this.#lifecycle.session.execute(command);
      return { duplicate: false };
    } catch (error) {
      this.#accepted.delete(command.commandId);
      throw error;
    }
  }

  public async shutdown(): Promise<string> {
    if (this.#lifecycle.kind !== "ready") throw new RuntimeInvariantError("Runtime is not ready");
    const session = this.#lifecycle.session;
    this.#lifecycle = { kind: "stopping", session };
    const fingerprint = await session.flush();
    await session.dispose();
    this.#lifecycle = { kind: "stopped", finalFingerprint: fingerprint };
    return fingerprint;
  }

  public fault(code: string): void {
    if (this.#lifecycle.kind === "stopped") return;
    this.#lifecycle = { kind: "faulted", code };
  }
}

export class RuntimeInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RuntimeInvariantError";
  }
}

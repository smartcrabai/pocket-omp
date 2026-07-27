export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type SessionId = Brand<string, "SessionId">;
export type RuntimeId = Brand<string, "RuntimeId">;
export type CommandId = Brand<string, "CommandId">;
export type RunId = Brand<string, "RunId">;
export type EventId = Brand<string, "EventId">;
export type UiRequestId = Brand<string, "UiRequestId">;
export type ApprovalRequestId = Brand<string, "ApprovalRequestId">;

function identifier<Name extends string>(value: string, name: Name): Brand<string, Name> {
  if (value.length === 0 || value.length > 128 || !/^[\x21-\x7e]+$/.test(value)) {
    throw new DomainValidationError(`Invalid ${name}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validation is the brand constructor.
  return value as Brand<string, Name>;
}

export const sessionId = (value: string): SessionId => identifier(value, "SessionId");
export const runtimeId = (value: string): RuntimeId => identifier(value, "RuntimeId");
export const commandId = (value: string): CommandId => identifier(value, "CommandId");
export const runId = (value: string): RunId => identifier(value, "RunId");
export const eventId = (value: string): EventId => identifier(value, "EventId");
export const uiRequestId = (value: string): UiRequestId => identifier(value, "UiRequestId");
export const approvalRequestId = (value: string): ApprovalRequestId =>
  identifier(value, "ApprovalRequestId");

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type AgentRunState = "idle" | "running" | "ended" | "failed" | "interrupted";

export type AgentCommand =
  | { readonly kind: "submit-prompt"; readonly commandId: CommandId; readonly text: string }
  | { readonly kind: "steer"; readonly commandId: CommandId; readonly text: string }
  | { readonly kind: "follow-up"; readonly commandId: CommandId; readonly text: string }
  | { readonly kind: "abort"; readonly commandId: CommandId }
  | { readonly kind: "compact"; readonly commandId: CommandId }
  | {
      readonly kind: "set-model";
      readonly commandId: CommandId;
      readonly provider: string;
      readonly modelId: string;
    }
  | {
      readonly kind: "set-thinking";
      readonly commandId: CommandId;
      readonly level: ThinkingLevel;
    }
  | {
      readonly kind: "approval-response";
      readonly commandId: CommandId;
      readonly approvalRequestId: ApprovalRequestId;
      readonly allow: boolean;
      readonly displayedContentHash: Uint8Array;
    }
  | {
      readonly kind: "ui-response";
      readonly commandId: CommandId;
      readonly uiRequestId: UiRequestId;
      readonly response: Uint8Array;
      readonly displayedContentHash: Uint8Array;
    };

export interface EventMetadata {
  readonly eventId: EventId;
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly revision: bigint;
  readonly createdAtMs: bigint;
  readonly runtimeGeneration: bigint;
  readonly causationCommandId?: CommandId;
}

export type AgentDomainEvent =
  | (EventMetadata & { readonly kind: "agent-started"; readonly runId: RunId })
  | (EventMetadata & { readonly kind: "message-started"; readonly messageId: string })
  | (EventMetadata & {
      readonly kind: "message-delta";
      readonly messageId: string;
      readonly delta: string;
    })
  | (EventMetadata & { readonly kind: "message-completed"; readonly messageId: string })
  | (EventMetadata & {
      readonly kind: "tool-started" | "tool-updated" | "tool-completed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly display: unknown;
    })
  | (EventMetadata & {
      readonly kind: "approval-requested";
      readonly approvalRequestId: ApprovalRequestId;
      readonly expiresAtMs: bigint;
      readonly summary: string;
      readonly contentHash: Uint8Array;
    })
  | (EventMetadata & {
      readonly kind: "ui-requested";
      readonly uiRequestId: UiRequestId;
      readonly uiKind: "confirm" | "select" | "input" | "editor";
      readonly expiresAtMs: bigint;
      readonly payload: unknown;
      readonly contentHash: Uint8Array;
    })
  | (EventMetadata & {
      readonly kind: "subagent-started" | "subagent-updated" | "subagent-completed";
      readonly taskId: string;
      readonly display: unknown;
    })
  | (EventMetadata & { readonly kind: "todo-updated"; readonly items: readonly TodoItem[] })
  | (EventMetadata & {
      readonly kind: "agent-ended" | "agent-failed" | "agent-interrupted";
      readonly runId: RunId;
      readonly reason?: string;
    });

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "in-progress" | "completed" | "cancelled";
}

export interface OmpCapabilityManifest {
  readonly sdkVersion: string;
  readonly sessionFormatVersion?: string;
  readonly sessionPersistence: boolean;
  readonly extensionUiKinds: readonly string[];
  readonly tools: readonly string[];
  readonly steering: boolean;
  readonly followUp: boolean;
  readonly compaction: boolean;
  readonly subagents: boolean;
  readonly mcp: boolean;
  readonly lsp: boolean;
}

export interface RuntimeCommandEnvelope {
  readonly command: AgentCommand;
  readonly issuedAtMs: bigint;
  readonly expiresAtMs: bigint;
}

export type CommandDecision =
  | { readonly accepted: true }
  | {
      readonly accepted: false;
      readonly code:
        | "DUPLICATE"
        | "EXPIRED"
        | "INVALID_WINDOW"
        | "INVALID_STATE"
        | "INVALID_CONTENT"
        | "STALE_RESPONSE";
    };

export class AgentRuntimeCore {
  private state: AgentRunState = "idle";
  private revision = 0n;
  private readonly processed = new Set<CommandId>();
  private readonly approvals = new Map<
    ApprovalRequestId,
    { readonly contentHash: Uint8Array; readonly expiresAtMs: bigint }
  >();
  private readonly uiRequests = new Map<
    UiRequestId,
    { readonly contentHash: Uint8Array; readonly expiresAtMs: bigint }
  >();

  public decide(envelope: RuntimeCommandEnvelope, nowMs: bigint): CommandDecision {
    const { command, issuedAtMs, expiresAtMs } = envelope;
    if (this.processed.has(command.commandId)) return { accepted: false, code: "DUPLICATE" };
    if (issuedAtMs > expiresAtMs) return { accepted: false, code: "INVALID_WINDOW" };
    if (nowMs > expiresAtMs) return { accepted: false, code: "EXPIRED" };
    if (!this.commandAllowed(command)) return { accepted: false, code: "INVALID_STATE" };
    if ("text" in command && command.text.trim().length === 0) {
      return { accepted: false, code: "INVALID_CONTENT" };
    }
    if (command.kind === "approval-response") {
      const pending = this.approvals.get(command.approvalRequestId);
      if (
        pending === undefined ||
        nowMs > pending.expiresAtMs ||
        !constantTimeEqual(pending.contentHash, command.displayedContentHash)
      ) {
        return { accepted: false, code: "STALE_RESPONSE" };
      }
      this.approvals.delete(command.approvalRequestId);
    }
    if (command.kind === "ui-response") {
      const pending = this.uiRequests.get(command.uiRequestId);
      if (
        pending === undefined ||
        nowMs > pending.expiresAtMs ||
        !constantTimeEqual(pending.contentHash, command.displayedContentHash)
      ) {
        return { accepted: false, code: "STALE_RESPONSE" };
      }
      this.uiRequests.delete(command.uiRequestId);
    }
    this.processed.add(command.commandId);
    return { accepted: true };
  }

  public observe(event: AgentDomainEvent): void {
    if (event.revision <= this.revision)
      throw new DomainValidationError("Event revision must increase");
    this.revision = event.revision;
    switch (event.kind) {
      case "agent-started":
        this.state = "running";
        break;
      case "agent-ended":
        this.state = "ended";
        break;
      case "agent-failed":
        this.state = "failed";
        break;
      case "agent-interrupted":
        this.state = "interrupted";
        break;
      case "approval-requested":
        this.approvals.set(event.approvalRequestId, {
          contentHash: event.contentHash.slice(),
          expiresAtMs: event.expiresAtMs,
        });
        break;
      case "ui-requested":
        this.uiRequests.set(event.uiRequestId, {
          contentHash: event.contentHash.slice(),
          expiresAtMs: event.expiresAtMs,
        });
        break;
      default:
        break;
    }
  }

  public get runState(): AgentRunState {
    return this.state;
  }

  public get currentRevision(): bigint {
    return this.revision;
  }

  private commandAllowed(command: AgentCommand): boolean {
    switch (command.kind) {
      case "submit-prompt":
        return this.state !== "running";
      case "steer":
      case "follow-up":
      case "abort":
        return this.state === "running";
      case "compact":
        return this.state !== "running";
      default:
        return true;
    }
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export class DomainValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

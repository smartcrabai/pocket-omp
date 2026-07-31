import type {
  AgentCommand,
  AgentDomainEvent,
  CommandId,
  OmpCapabilityManifest,
  RuntimeId,
  SessionId,
} from "@pocket-omp/agent-domain";

export type OwnershipState =
  | { readonly kind: "idle"; readonly epoch: bigint }
  | { readonly kind: "pocket-owned"; readonly epoch: bigint; readonly runtimeId: RuntimeId }
  | { readonly kind: "handoff-pending"; readonly epoch: bigint; readonly runtimeId: RuntimeId }
  | { readonly kind: "tui-owned"; readonly epoch: bigint; readonly processId: number }
  | { readonly kind: "external-owned"; readonly epoch: bigint }
  | { readonly kind: "verifying"; readonly epoch: bigint }
  | { readonly kind: "conflict"; readonly epoch: bigint; readonly reason: string };

export type OwnershipAction =
  | { readonly kind: "acquire-pocket"; readonly runtimeId: RuntimeId }
  | { readonly kind: "prepare-handoff" }
  | { readonly kind: "handoff-ready"; readonly processId: number }
  | { readonly kind: "handoff-failed" }
  | { readonly kind: "managed-tui-exited" }
  | { readonly kind: "external-writer-detected"; readonly reason: string }
  | { readonly kind: "verification-succeeded" }
  | { readonly kind: "release" }
  | { readonly kind: "recover-conflict" };

export function transitionOwnership(
  state: OwnershipState,
  action: OwnershipAction,
): OwnershipState {
  const nextEpoch = state.epoch + 1n;
  switch (state.kind) {
    case "idle":
      if (action.kind === "acquire-pocket") {
        return { kind: "pocket-owned", epoch: nextEpoch, runtimeId: action.runtimeId };
      }
      if (action.kind === "external-writer-detected") {
        return { kind: "external-owned", epoch: nextEpoch };
      }
      break;
    case "pocket-owned":
      if (action.kind === "prepare-handoff") {
        return { kind: "handoff-pending", epoch: nextEpoch, runtimeId: state.runtimeId };
      }
      if (action.kind === "release") return { kind: "idle", epoch: nextEpoch };
      if (action.kind === "external-writer-detected") {
        return { kind: "conflict", epoch: nextEpoch, reason: action.reason };
      }
      break;
    case "handoff-pending":
      if (action.kind === "handoff-ready") {
        return { kind: "tui-owned", epoch: nextEpoch, processId: action.processId };
      }
      if (action.kind === "handoff-failed") {
        return { kind: "pocket-owned", epoch: nextEpoch, runtimeId: state.runtimeId };
      }
      if (action.kind === "external-writer-detected") {
        return { kind: "conflict", epoch: nextEpoch, reason: action.reason };
      }
      break;
    case "tui-owned":
      if (action.kind === "managed-tui-exited") return { kind: "verifying", epoch: nextEpoch };
      if (action.kind === "external-writer-detected")
        return { kind: "verifying", epoch: nextEpoch };
      break;
    case "verifying":
      if (action.kind === "verification-succeeded") return { kind: "idle", epoch: nextEpoch };
      if (action.kind === "external-writer-detected") {
        return { kind: "conflict", epoch: nextEpoch, reason: action.reason };
      }
      break;
    case "external-owned":
      if (action.kind === "verification-succeeded") return { kind: "idle", epoch: nextEpoch };
      break;
    case "conflict":
      if (action.kind === "recover-conflict") return { kind: "idle", epoch: nextEpoch };
      break;
  }
  throw new HostInvariantError(`Invalid ownership transition ${state.kind} -> ${action.kind}`);
}

export interface OmpSessionSummary {
  readonly sessionId: SessionId;
  readonly path: string;
  readonly cwd: string;
  /** Best-effort display title (OMP's SessionInfo.title). Absent when OMP has none recorded. */
  readonly title?: string;
  readonly updatedAtMs: bigint;
  readonly compatibility: SessionCompatibility;
}

// "indeterminate" was added alongside the other six for the Host session-list
// feature (packages/omp-sdk-adapter's SessionManager.list wiring): that
// listing is a cheap, lock-free metadata scan (OMP's SessionInfo) that
// exposes no session-file-format version, no SDK version, and no
// corruption/parse-failure signal for sessions it did not actually open --
// see packages/omp-sdk-adapter/src/session-list.ts's doc comment for the
// full accounting of what is/isn't derivable from it. Callers that only have
// SessionInfo-level data MUST use "indeterminate" rather than guess one of
// the other six; only a real SessionManager.open() (or equivalent) can prove
// one of them.
export type SessionCompatibility =
  | "fully-compatible"
  | "supported-older-requires-backup"
  | "newer-than-runtime"
  | "unsupported"
  | "corrupt"
  | "ownership-conflict"
  | "indeterminate";

export interface StartRuntimeInput {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly sessionPath?: string;
  readonly runtimeGeneration: bigint;
}

export interface AgentRuntimeHandle {
  readonly runtimeId: RuntimeId;
  readonly runtimeGeneration: bigint;
  readonly capabilities: OmpCapabilityManifest;
}

export interface AgentRuntimeSupervisor {
  listSessions(input: { readonly cwd?: string }): Promise<readonly OmpSessionSummary[]>;
  start(input: StartRuntimeInput): Promise<AgentRuntimeHandle>;
  send(runtimeId: RuntimeId, command: AgentCommand): Promise<{ readonly commandId: CommandId }>;
  events(runtimeId: RuntimeId): AsyncIterable<AgentDomainEvent>;
  prepareHandoff(input: {
    readonly sessionId: SessionId;
    readonly abortActiveRun: boolean;
  }): Promise<{
    readonly ticket: string;
    readonly sessionPath: string;
    readonly cwd: string;
    readonly expiresAtMs: bigint;
  }>;
  stop(runtimeId: RuntimeId, reason: "clean" | "abort" | "handoff" | "conflict"): Promise<void>;
}

// The Host session-list feature only needs "listSessions" of
// AgentRuntimeSupervisor's six methods; start/send/events/prepareHandoff/stop
// (spawning and driving an Agent Runtime process) are out of scope for it.
// Rather than declaring a parallel one-method interface with its own copy of
// the same signature, this is a structural `Pick` of the full port -- the
// same "narrow slice of a bigger port" idiom already used by
// apps/host/src/runtime-event-forwarder.ts's
// `RuntimeEventRelay.coordinator: Pick<HostRelayCoordinator, "enqueue">`.
// Consequences: a fake only needs to implement `listSessions` to satisfy
// this port in tests, and any future full AgentRuntimeSupervisor
// implementation automatically satisfies it too, with zero duplication.
export type SessionListPort = Pick<AgentRuntimeSupervisor, "listSessions">;

export interface RelayGateway {
  subscribe(afterServerSequence: bigint, signal: AbortSignal): AsyncIterable<unknown>;
  publish(envelopes: readonly unknown[], ackServerSequence?: bigint): Promise<unknown>;
  acknowledge(serverSequence: bigint): Promise<void>;
}

export interface SecureKeyStore {
  put(handle: string, secret: Uint8Array): Promise<void>;
  get(handle: string): Promise<Uint8Array | undefined>;
  delete(handle: string): Promise<void>;
}

export interface HostInboundEnvelope {
  readonly messageId: string;
  readonly serverSequence: bigint;
  readonly encrypted: unknown;
}

export interface HostOutboxItem {
  readonly messageId: string;
  readonly encrypted: unknown;
}

export interface HostDeliveryStore {
  relayCursor(): Promise<bigint>;
  appendOutbox(item: HostOutboxItem): Promise<boolean>;
  pendingOutbox(limit: number): Promise<readonly HostOutboxItem[]>;
  markOutboxPublished(messageIds: readonly string[]): Promise<void>;
  persistInbound(envelope: HostInboundEnvelope): Promise<boolean>;
  pendingInbound(limit: number): Promise<readonly HostInboundEnvelope[]>;
  markInboundHandled(messageId: string): Promise<void>;
  advanceRelayCursor(serverSequence: bigint): Promise<void>;
}

export interface HostEnvelopeCrypto {
  seal(recipientDeviceId: string, plaintext: Uint8Array): Promise<HostOutboxItem>;
  open(envelope: HostInboundEnvelope): Promise<Uint8Array>;
}

export interface HostCommandDispatcher {
  dispatch(messageId: string, plaintext: Uint8Array): Promise<void>;
}

export class HostRelayCoordinator {
  public constructor(
    private readonly relay: RelayGateway,
    private readonly store: HostDeliveryStore,
    private readonly crypto: HostEnvelopeCrypto,
    private readonly dispatcher: HostCommandDispatcher,
  ) {}

  public async enqueue(
    recipientDeviceId: string,
    plaintext: Uint8Array,
  ): Promise<{ readonly duplicate: boolean }> {
    if (plaintext.byteLength === 0)
      throw new HostInvariantError("Cannot enqueue an empty Host message");
    const envelope = await this.crypto.seal(recipientDeviceId, plaintext);
    return { duplicate: !(await this.store.appendOutbox(envelope)) };
  }

  public async flushOutbox(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new HostInvariantError("Invalid Host outbox batch limit");
    }
    const batch = await this.store.pendingOutbox(limit);
    if (batch.length === 0) return 0;
    await this.relay.publish(batch);
    await this.store.markOutboxPublished(batch.map((item) => item.messageId));
    return batch.length;
  }

  public async receive(signal: AbortSignal): Promise<void> {
    const cursor = await this.store.relayCursor();
    for await (const value of this.relay.subscribe(cursor, signal)) {
      if (signal.aborted) break;
      const envelope = hostInboundEnvelope(value);
      await this.store.persistInbound(envelope);
      await this.drainInbound();
    }
  }

  public async drainInbound(limit = 100): Promise<number> {
    const pending = await this.store.pendingInbound(limit);
    /* oxlint-disable eslint/no-await-in-loop -- Inbound dispatch, cursor advancement, and ACK must preserve server sequence order. */
    for (const envelope of pending) {
      const plaintext = await this.crypto.open(envelope);
      await this.dispatcher.dispatch(envelope.messageId, plaintext);
      await this.store.markInboundHandled(envelope.messageId);
      await this.store.advanceRelayCursor(envelope.serverSequence);
      await this.relay.acknowledge(envelope.serverSequence);
    }
    /* oxlint-enable eslint/no-await-in-loop */
    return pending.length;
  }
}

function hostInboundEnvelope(value: unknown): HostInboundEnvelope {
  if (
    typeof value !== "object" ||
    value === null ||
    !("messageId" in value) ||
    typeof value.messageId !== "string" ||
    value.messageId.length === 0 ||
    !("serverSequence" in value) ||
    typeof value.serverSequence !== "bigint" ||
    value.serverSequence <= 0n ||
    !("encrypted" in value)
  ) {
    throw new HostInvariantError("Relay produced an invalid inbound envelope");
  }
  return {
    messageId: value.messageId,
    serverSequence: value.serverSequence,
    encrypted: value.encrypted,
  };
}

export type PermissionPreset =
  | { readonly kind: "safe" }
  | { readonly kind: "trusted-workspace" }
  | { readonly kind: "unattended"; readonly locallyEnabled: true; readonly expiresAtMs: bigint };

export type WorkspaceOperation =
  | "read"
  | "write"
  | "bash"
  | "subagent"
  | "browser"
  | "git-destructive";

export type PermissionDecision = "allow" | "require-mobile-approval" | "deny";

export function decideWorkspacePermission(
  preset: PermissionPreset,
  operation: WorkspaceOperation,
  nowMs: bigint,
): PermissionDecision {
  if (preset.kind === "unattended") {
    return nowMs <= preset.expiresAtMs ? "allow" : "deny";
  }
  if (operation === "browser") return "deny";
  if (operation === "read") return "allow";
  if (preset.kind === "trusted-workspace" && operation === "write") return "allow";
  return "require-mobile-approval";
}

export interface PendingHostApproval {
  readonly approvalRequestId: string;
  readonly sessionId: SessionId;
  readonly routeId: string;
  readonly runtimeGeneration: bigint;
  readonly contentHash: Uint8Array;
  readonly expiresAtMs: bigint;
}

export interface HostApprovalResponse {
  readonly approvalRequestId: string;
  readonly sessionId: SessionId;
  readonly routeId: string;
  readonly runtimeGeneration: bigint;
  readonly displayedContentHash: Uint8Array;
  readonly allow: boolean;
}

export function verifyHostApproval(
  pending: PendingHostApproval,
  response: HostApprovalResponse,
  nowMs: bigint,
  routeActive: boolean,
): boolean {
  return (
    routeActive &&
    response.allow &&
    nowMs <= pending.expiresAtMs &&
    response.approvalRequestId === pending.approvalRequestId &&
    response.sessionId === pending.sessionId &&
    response.routeId === pending.routeId &&
    response.runtimeGeneration === pending.runtimeGeneration &&
    secureEqual(response.displayedContentHash, pending.contentHash)
  );
}

function secureEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export class HostInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HostInvariantError";
  }
}

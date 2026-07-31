// Minimal HostCommandDispatcher (host-core) stand-in.
//
// This task only wires the relay transport end to end (HostRelayCoordinator
// <- RelayGateway/HostDeliveryStore/HostEnvelopeCrypto); connecting inbound
// SecurePayloads to the OMP Runtime (ClientCommand -> AgentRuntimeSupervisor)
// is a follow-up task. Until then, every inbound message is decoded far
// enough to identify its SecurePayloadCase `kind` and then intentionally
// dropped: this keeps HostRelayCoordinator's persist -> dispatch -> ack
// pipeline exercisable end to end (and safe -- nothing here can crash the
// daemon or wedge the inbound queue) without pretending to implement real
// command handling.
import type { HostCommandDispatcher } from "@pocket-omp/host-core";
import { decodeSecurePayload } from "@pocket-omp/session-protocol";

export interface InboundDispatchEvent {
  readonly messageId: string;
  readonly kind: string;
}

export interface StubCommandDispatcherOptions {
  readonly onInbound?: (event: InboundDispatchEvent) => void;
}

export function createStubCommandDispatcher(
  options: StubCommandDispatcherOptions = {},
): HostCommandDispatcher {
  const onInbound = options.onInbound ?? ((): void => undefined);
  return {
    async dispatch(messageId: string, plaintext: Uint8Array): Promise<void> {
      try {
        const payload = decodeSecurePayload(plaintext);
        onInbound({ messageId, kind: payload.body.kind });
      } catch (error) {
        // A message this Host can never decode can never succeed on retry
        // either, so this is recorded as an "unsupported" observation
        // rather than re-thrown: re-throwing here would make
        // HostRelayCoordinator.drainInbound() leave the envelope pending
        // forever (never marked handled, never acked), permanently
        // wedging the inbound queue behind one poison message.
        onInbound({
          messageId,
          kind: `decode-error:${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  };
}

// MobileEnvelopeCrypto implementation (packages/mobile-core). Deliberately
// takes its pairwise-key lookup as an injected dependency rather than
// importing expo-secure-store directly, so this file -- unlike
// app/pair.tsx's direct SecureStore usage -- can still be exercised by
// `bun test`; the composition root wires the real expo-secure-store module
// in (it satisfies PairwiseKeyStore structurally, see routePairwiseKeyKey).
import type {
  MobileEnvelopeCrypto,
  MobileRelayFrame,
  ProjectionEvent,
} from "@pocket-omp/mobile-core";
import type { SealedEnvelope } from "@pocket-omp/proto/relay/v1";
import { openSecurePayload } from "@pocket-omp/session-protocol";
import { toProjectionEvent } from "./relay-projection";

export interface PairwiseKeyStore {
  getItemAsync(key: string): Promise<string | null>;
}

// Mirrors the `route.{routeId}.key` naming already established by
// app/pair.tsx when it stores the pairwise key derived during pairing.
export function routePairwiseKeyKey(routeId: string): string {
  return `route.${routeId}.key`;
}

export class MissingPairwiseKeyError extends Error {
  public constructor(routeId: string) {
    super(`No pairwise key is stored for route ${routeId}`);
    this.name = "MissingPairwiseKeyError";
  }
}

export class MalformedRelayFrameError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MalformedRelayFrameError";
  }
}

export class SecureStoreEnvelopeCrypto implements MobileEnvelopeCrypto {
  public constructor(private readonly keyStore: PairwiseKeyStore) {}

  public async open(frame: MobileRelayFrame): Promise<ProjectionEvent> {
    const envelope = asSealedEnvelope(frame.encrypted);
    const storedKey = await this.keyStore.getItemAsync(routePairwiseKeyKey(envelope.routeId));
    if (storedKey === null) throw new MissingPairwiseKeyError(envelope.routeId);
    const pairwiseKey = fromBase64(storedKey);
    const body = openSecurePayload(pairwiseKey, envelope);
    return toProjectionEvent(frame.eventId, body);
  }
}

// The relay port (relay-port.ts) is the only producer of MobileRelayFrame
// values and always sets `encrypted` to the decoded SealedEnvelope proto
// message; this guard exists because the mobile-core interface types
// `encrypted` as `unknown`.
function asSealedEnvelope(value: unknown): SealedEnvelope {
  if (!isSealedEnvelope(value))
    throw new MalformedRelayFrameError("Relay frame does not contain a sealed envelope");
  return value;
}

function isSealedEnvelope(value: unknown): value is SealedEnvelope {
  return isRecord(value) && value.$typeName === "pocket.omp.relay.v1.SealedEnvelope";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// Integration test: wires the three real MobileRelayPort / MobileProjectionStore
// / MobileEnvelopeCrypto implementations added by this task into a real
// MobileStreamManager (packages/mobile-core), with only the WebSocket,
// fetch, and SecureStore edges faked. This is the "3 fakes at the transport
// boundary, everything else real" test the task asks for, verifying commit
// -> ack ordering and that `state` reaches `live` end-to-end.
import { eventId, sessionId } from "@pocket-omp/agent-domain";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { MobileStreamManager, type StreamState } from "@pocket-omp/mobile-core";
import {
  AckRequestSchema,
  AckResponseSchema,
  DeliveredEnvelopeSchema,
  GetSnapshotRequestSchema,
  GetSnapshotResponseSchema,
  NotificationHint,
  Priority,
  RelayFrameSchema,
  SealedEnvelopeSchema,
} from "@pocket-omp/proto/relay/v1";
import {
  encodeTranscriptEvent,
  sealSecurePayload,
  type SecurePayloadBody,
} from "@pocket-omp/session-protocol";
import { DEVICE_CREDENTIAL_PREFIX } from "../src/credential-validation";
import { SecureStoreEnvelopeCrypto } from "../src/relay-crypto";
import {
  MobileWebSocketRelayPort,
  type RelayFetch,
  type RelaySocket,
  type RelaySocketEvent,
} from "../src/relay-port";
import { routeProjectionCursorKey, SecureProjectionStore } from "../src/projection-store";

class FakeWebSocket implements RelaySocket {
  public binaryType = "";
  public readyState = 1;
  readonly #listeners = new Map<string, Set<(event: RelaySocketEvent) => void>>();

  public constructor(
    public readonly url: string,
    public readonly protocols: readonly string[],
  ) {}

  public send(): void {
    // Not exercised by this test.
  }

  public close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { data: undefined });
  }

  public addEventListener(type: string, listener: (event: RelaySocketEvent) => void): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  public removeEventListener(type: string, listener: (event: RelaySocketEvent) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public emitMessage(data: Uint8Array): void {
    this.#emit("message", { data });
  }

  #emit(type: string, event: RelaySocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  /* oxlint-disable-next-line eslint/no-await-in-loop -- polls until the async pipeline under test (commit/ack) settles; each check must run after the previous tick, not in parallel. */
  for (let attempt = 0; attempt < 50 && !predicate(); attempt += 1) await flushMicrotasks();
  if (!predicate()) throw new Error("condition was not met in time");
}

// Both fake protobuf endpoints below are always called with a binary body;
// only relay-ticket.ts's JSON request uses a string body. Narrowing here
// (rather than an `as Uint8Array` cast) keeps a mismatch-with-reality a loud
// test failure instead of a silent unsafe assertion.
function bodyBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (!(body instanceof Uint8Array)) throw new Error("expected a binary request body");
  return body;
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function toBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function sealedRelayFrameBytes(
  serverSequence: bigint,
  routeId: string,
  pairwiseKey: Uint8Array,
  messageId: string,
  body: SecurePayloadBody,
): Uint8Array {
  const outbound = sealSecurePayload(
    pairwiseKey,
    {
      messageId,
      routeId,
      senderDeviceId: "host-device",
      recipientDeviceId: "mobile-device-1",
      clientSequence: serverSequence,
      createdAtMs: 1_700_000_000_000n,
      expiresAtMs: 1_700_000_600_000n,
      keyId: "key-1",
      priority: Priority.NORMAL,
      notificationHint: NotificationHint.NONE,
    },
    body,
    { bytes: randomBytes },
  );
  return toBinary(
    RelayFrameSchema,
    create(RelayFrameSchema, {
      body: {
        case: "envelope",
        value: create(DeliveredEnvelopeSchema, {
          serverSequence,
          envelope: create(SealedEnvelopeSchema, {
            messageId: outbound.messageId,
            routeId: outbound.routeId,
            senderDeviceId: outbound.senderDeviceId,
            recipientDeviceId: outbound.recipientDeviceId,
            clientSequence: outbound.clientSequence,
            createdAtMs: outbound.createdAtMs,
            expiresAtMs: outbound.expiresAtMs,
            keyId: outbound.keyId,
            nonce: outbound.nonce,
            ciphertext: outbound.ciphertext,
            priority: outbound.priority,
            notificationHint: outbound.notificationHint,
          }),
        }),
      },
    }),
  );
}

describe("MobileStreamManager wired to the real relay port, projection store, and crypto", () => {
  test("delivers frames commit-before-ack, in order, and reaches the live state", async () => {
    const routeId = "route-1";
    const pairwiseKey = randomBytes(32);
    const secureStoreValues = new Map<string, string>([
      [`route.${routeId}.key`, toBase64(pairwiseKey)],
    ]);
    const secureStore = {
      getItemAsync: (key: string) => Promise.resolve(secureStoreValues.get(key) ?? null),
      setItemAsync: (key: string, value: string) => {
        secureStoreValues.set(key, value);
        return Promise.resolve();
      },
    };

    const order: string[] = [];
    const sockets: FakeWebSocket[] = [];
    class TrackedFakeWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }

    const fetchStub = async (
      input: string | URL,
      init?: Parameters<RelayFetch>[1],
    ): Promise<Response> => {
      const url = input.toString();
      if (url === "https://control.example/v1/relay-tickets") {
        return Response.json({
          ticket: "ticket-value",
          relay_origin: "https://relay.example",
          expires_at_ms: 9_999_999_999,
          route_epoch: "1",
        });
      }
      if (url === "https://relay.example/v1/relay/snapshot") {
        fromBinary(GetSnapshotRequestSchema, bodyBytes(init?.body));
        // No snapshot has ever been created for this fresh device; the port
        // falls back to after=0 (see relay-port.ts's #fetchSnapshotCursor
        // catch handler in subscribe()).
        return new Response(
          toBinary(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema, {})),
          { status: 200, headers: { "content-type": "application/protobuf" } },
        );
      }
      if (url === "https://relay.example/v1/relay/ack") {
        const body = fromBinary(AckRequestSchema, bodyBytes(init?.body));
        order.push(`ack:${body.serverSequence}`);
        return new Response(
          toBinary(
            AckResponseSchema,
            create(AckResponseSchema, { acceptedServerSequence: body.serverSequence }),
          ),
          { status: 200, headers: { "content-type": "application/protobuf" } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    };

    const port = new MobileWebSocketRelayPort({
      fetch: fetchStub,
      webSocket: TrackedFakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: {
        deviceId: "mobile-device-1",
        credential: `${DEVICE_CREDENTIAL_PREFIX}${"a1".repeat(32)}`,
      },
    });
    const store = new SecureProjectionStore(routeId, secureStore);
    const originalCommit = store.commit.bind(store);
    // Wrap commit() (rather than reading it back out of secureStoreValues)
    // so the ordering assertion reflects the exact call MobileStreamManager
    // makes, not a side channel.
    store.commit = async (cursor, projection) => {
      await originalCommit(cursor, projection);
      order.push(`commit:${cursor}`);
    };
    const crypto2 = new SecureStoreEnvelopeCrypto(secureStore);

    const states: StreamState[] = [];
    const manager = new MobileStreamManager(port, store, crypto2, (state) => states.push(state));

    const controller = new AbortController();
    const runPromise = manager.run(controller.signal);

    await waitUntil(() => sockets.length === 1);
    const socket = sockets[0];
    if (socket === undefined) throw new Error("expected a socket to have been created");

    socket.emitMessage(
      sealedRelayFrameBytes(1n, routeId, pairwiseKey, "message-1", {
        capabilitySet: "v1",
        body: {
          kind: "session-event",
          value: {
            eventId: eventId("event-1"),
            sessionId: sessionId("session-1"),
            revision: 1n,
            createdAtMs: 1_700_000_000_000n,
            runtimeGeneration: 1n,
            hostId: "host-1",
            kind: "message-delta",
            payload: encodeTranscriptEvent({
              kind: "message-delta",
              messageId: "message-1",
              delta: "a",
            }),
          },
        },
      }),
    );
    await waitUntil(() => order.includes("ack:1"));

    socket.emitMessage(
      sealedRelayFrameBytes(2n, routeId, pairwiseKey, "message-2", {
        capabilitySet: "v1",
        body: {
          kind: "session-event",
          value: {
            eventId: eventId("event-2"),
            sessionId: sessionId("session-1"),
            revision: 2n,
            createdAtMs: 1_700_000_000_001n,
            runtimeGeneration: 1n,
            hostId: "host-1",
            kind: "message-delta",
            payload: encodeTranscriptEvent({
              kind: "message-delta",
              messageId: "message-1",
              delta: "b",
            }),
          },
        },
      }),
    );
    await waitUntil(() => order.includes("ack:2"));

    expect(order).toEqual(["commit:1", "ack:1", "commit:2", "ack:2"]);
    expect(manager.state.kind).toBe("live");
    if (manager.state.kind === "live") expect(manager.state.cursor).toBe(2n);
    expect(secureStoreValues.get(routeProjectionCursorKey(routeId))).toBe("2");

    controller.abort();
    await runPromise;
    expect(states.some((state) => state.kind === "live")).toBeTrue();
  });
});

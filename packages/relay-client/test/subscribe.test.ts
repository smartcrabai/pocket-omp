// Covers WorkerRelayClient.subscribe(): the WebSocket half of the client
// (URL/subprotocol construction, frame decoding, error/close/abort
// cleanup). HTTP RPCs are covered separately in http.test.ts.
//
// FakeRelaySocket implements `RelaySocket` (packages/relay-client/src/
// index.ts) -- the narrowed WebSocket surface added alongside this test
// suite so a fake needs to implement only what subscribe() actually uses,
// not the full global WebSocket interface (ping/pong/terminate/onopen...).
// Mirrors apps/mobile/test/relay-port.test.ts's FakeWebSocket.

import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import {
  DeliveredEnvelopeSchema,
  NotificationHint,
  Priority,
  RelayFrameSchema,
  ResetRequiredSchema,
  SealedEnvelopeSchema,
  SubscribeRequestSchema,
  type RelayFrame,
  type SubscribeRequest,
} from "@pocket-omp/proto/relay/v1";
import {
  RelayClientError,
  WorkerRelayClient,
  type RelaySocket,
  type RelaySocketConstructor,
  type RelaySocketEvent,
} from "../src/index";

const BASE_URL = "https://relay.example.com";

// Standard WebSocket readyState values (avoids depending on the global
// `WebSocket` class purely for its static constants).
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

type Listener = (event: RelaySocketEvent) => void;

interface CloseCall {
  readonly code: number | undefined;
  readonly reason: string | undefined;
}

// Starts already OPEN (skips the connecting-handshake branch, which is
// covered by its own dedicated tests below) so most tests can drive frames
// immediately, mirroring apps/mobile/test/relay-port.test.ts's FakeWebSocket.
class FakeRelaySocket implements RelaySocket {
  public binaryType = "";
  public readyState = OPEN;
  public readonly closeCalls: CloseCall[] = [];
  readonly #listeners = new Map<string, Set<Listener>>();

  public constructor(
    public readonly url: string,
    public readonly protocols: string[],
  ) {}

  public addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: Listener,
    options?: { readonly once?: boolean },
  ): void {
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    if (options?.once !== true) {
      set.add(listener);
      return;
    }
    const wrapped: Listener = (event) => {
      this.#listeners.get(type)?.delete(wrapped);
      listener(event);
    };
    set.add(wrapped);
  }

  public removeEventListener(type: "open" | "error", listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closeCalls.push({ code, reason });
    this.#emit("close", { data: undefined });
  }

  public emitOpen(): void {
    this.readyState = OPEN;
    this.#emit("open", { data: undefined });
  }

  public emitMessage(data: unknown): void {
    this.#emit("message", { data });
  }

  public emitError(): void {
    this.#emit("error", { data: undefined });
  }

  #emit(type: string, event: RelaySocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

// A socket that starts CONNECTING, for the tests exercising subscribe()'s
// wait-for-open handshake branch.
class ConnectingFakeRelaySocket extends FakeRelaySocket {
  public constructor(url: string, protocols: string[]) {
    super(url, protocols);
    this.readyState = CONNECTING;
  }
}

function trackingSocketConstructor(sockets: FakeRelaySocket[]): RelaySocketConstructor {
  return class extends FakeRelaySocket {
    public constructor(url: string, protocols: string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  };
}

function trackingConnectingSocketConstructor(
  sockets: ConnectingFakeRelaySocket[],
): RelaySocketConstructor {
  return class extends ConnectingFakeRelaySocket {
    public constructor(url: string, protocols: string[]) {
      super(url, protocols);
      sockets.push(this);
    }
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function subscribeRequest(
  overrides: Partial<{
    recipientDeviceId: string;
    afterServerSequence: bigint;
    connectionGeneration: string;
    protocolVersion: number;
  }> = {},
): SubscribeRequest {
  return create(SubscribeRequestSchema, {
    recipientDeviceId: "mobile-1",
    afterServerSequence: 0n,
    connectionGeneration: "gen-1",
    protocolVersion: 1,
    ...overrides,
  });
}

function envelopeFrameBytes(serverSequence: bigint, messageId: string): Uint8Array {
  return toBinary(
    RelayFrameSchema,
    create(RelayFrameSchema, {
      body: {
        case: "envelope",
        value: create(DeliveredEnvelopeSchema, {
          serverSequence,
          envelope: create(SealedEnvelopeSchema, {
            messageId,
            routeId: "route-1",
            senderDeviceId: "host-1",
            recipientDeviceId: "mobile-1",
            clientSequence: 1n,
            createdAtMs: 1n,
            expiresAtMs: 2n,
            keyId: "key-1",
            nonce: new Uint8Array(24),
            ciphertext: new Uint8Array([1, 2, 3]),
            priority: Priority.NORMAL,
            notificationHint: NotificationHint.NONE,
          }),
        }),
      },
    }),
  );
}

function resetFrameBytes(reason: string, latestSnapshotId: string, earliest: bigint): Uint8Array {
  return toBinary(
    RelayFrameSchema,
    create(RelayFrameSchema, {
      body: {
        case: "resetRequired",
        value: create(ResetRequiredSchema, {
          reason,
          latestSnapshotId,
          earliestAvailableSequence: earliest,
        }),
      },
    }),
  );
}

test("subscribe() opens a WebSocket with the expected URL/subprotocols/binaryType and yields decoded frames in order", async () => {
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
    ticket: "ticket-value",
  });
  const controller = new AbortController();
  const stream = relay.subscribe(
    subscribeRequest({
      recipientDeviceId: "mobile-1",
      afterServerSequence: 41n,
      connectionGeneration: "gen-1",
    }),
    controller.signal,
  );
  const iterator = stream[Symbol.asyncIterator]();

  const firstNext = iterator.next();
  await flushMicrotasks();

  expect(sockets).toHaveLength(1);
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");
  const url = new URL(socket.url);
  expect(url.protocol).toBe("wss:");
  expect(url.pathname).toBe("/v1/relay/subscribe");
  expect(url.searchParams.get("recipient_device_id")).toBe("mobile-1");
  expect(url.searchParams.get("after")).toBe("41");
  expect(url.searchParams.get("generation")).toBe("gen-1");
  expect(socket.protocols).toEqual(["pocket-omp-relay", "pocket-omp-ticket.ticket-value"]);
  expect(socket.binaryType).toBe("arraybuffer");

  // Delivered as a raw ArrayBuffer (one of the three binary shapes
  // messageBytes() accepts alongside Uint8Array/Blob).
  socket.emitMessage(envelopeFrameBytes(42n, "message-1").buffer);
  const first = await firstNext;
  expect(first.done).toBeFalse();
  if (first.done === true) throw new Error("expected an envelope frame");
  expect(first.value.body.case).toBe("envelope");
  if (first.value.body.case !== "envelope") throw new Error("expected an envelope frame body");
  expect(first.value.body.value.serverSequence).toBe(42n);
  expect(first.value.body.value.envelope?.messageId).toBe("message-1");

  const secondNext = iterator.next();
  socket.emitMessage(resetFrameBytes("retention gap", "snapshot-1", 100n));
  const second = await secondNext;
  expect(second.done).toBeFalse();
  if (second.done === true) throw new Error("expected a resetRequired frame");
  expect(second.value.body.case).toBe("resetRequired");
  if (second.value.body.case !== "resetRequired") throw new Error("expected resetRequired body");
  expect(second.value.body.value.reason).toBe("retention gap");
  expect(second.value.body.value.latestSnapshotId).toBe("snapshot-1");
  expect(second.value.body.value.earliestAvailableSequence).toBe(100n);

  controller.abort();
  const afterAbort = await iterator.next();
  expect(afterAbort.done).toBeTrue();
  expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Subscription aborted" }]);
});

test("subscribe() decodes a frame delivered as a Blob message", async () => {
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");

  socket.emitMessage(new Blob([envelopeFrameBytes(3n, "message-blob")]));
  const result = await nextPromise;
  expect(result.done).toBeFalse();
  if (result.done === true) throw new Error("expected an envelope frame");
  expect(result.value.body.case).toBe("envelope");

  controller.abort();
  await iterator.next();
});

test("subscribe() uses only the base subprotocol when no ticket is configured", async () => {
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  await flushMicrotasks();
  expect(sockets[0]?.protocols).toEqual(["pocket-omp-relay"]);
  controller.abort();
  const result = await nextPromise;
  expect(result.done).toBeTrue();
});

test("subscribe() waits for the open event when the socket starts CONNECTING, then yields frames", async () => {
  const sockets: ConnectingFakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingConnectingSocketConstructor(sockets),
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");
  expect(socket.closeCalls).toHaveLength(0);

  socket.emitOpen();
  await flushMicrotasks();
  socket.emitMessage(envelopeFrameBytes(7n, "message-open"));
  const result = await nextPromise;
  expect(result.done).toBeFalse();
  if (result.done === true) throw new Error("expected an envelope frame");
  expect(result.value.body.case).toBe("envelope");

  controller.abort();
  await iterator.next();
});

test("subscribe() rejects with CONNECTION_FAILED when the socket errors while still connecting, without leaking the ticket", async () => {
  const ticket = "connecting-secret-ticket";
  const sockets: ConnectingFakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingConnectingSocketConstructor(sockets),
    ticket,
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");

  socket.emitError();
  const error = await nextPromise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RelayClientError);
  if (!(error instanceof RelayClientError)) throw new Error("expected a RelayClientError");
  expect(error.code).toBe("CONNECTION_FAILED");
  expect(error.message).not.toContain(ticket);
});

test("subscribe() surfaces a WebSocket error after the connection is established as CONNECTION_FAILED", async () => {
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const firstNext = iterator.next();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");

  socket.emitMessage(envelopeFrameBytes(1n, "message-1"));
  const first = await firstNext;
  expect(first.done).toBeFalse();

  const secondNext = iterator.next();
  socket.emitError();
  const error = await secondNext.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RelayClientError);
  if (!(error instanceof RelayClientError)) throw new Error("expected a RelayClientError");
  expect(error.code).toBe("CONNECTION_FAILED");
});

test("subscribe() ends the stream when the socket closes with no pending frames", async () => {
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");

  socket.close(1000, "server done");
  const result = await nextPromise;
  expect(result.done).toBeTrue();
});

test("subscribe() surfaces a malformed relay frame as MALFORMED_FRAME, closes the socket with code 1002, and doesn't leak the ticket", async () => {
  const ticket = "malformed-frame-secret-ticket";
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
    ticket,
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");

  socket.emitMessage(new Uint8Array([0xff, 0xff, 0xff]));
  const error = await nextPromise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RelayClientError);
  if (!(error instanceof RelayClientError)) throw new Error("expected a RelayClientError");
  expect(error.code).toBe("MALFORMED_FRAME");
  expect(error.message).not.toContain(ticket);
  expect(socket.closeCalls).toEqual([{ code: 1002, reason: "Malformed relay frame" }]);
});

test("subscribe() surfaces a non-binary WebSocket message as MALFORMED_FRAME", async () => {
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
  });
  const controller = new AbortController();
  const iterator = relay.subscribe(subscribeRequest(), controller.signal)[Symbol.asyncIterator]();
  const nextPromise = iterator.next();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");

  socket.emitMessage("not binary");
  const error = await nextPromise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RelayClientError);
  if (!(error instanceof RelayClientError)) throw new Error("expected a RelayClientError");
  expect(error.code).toBe("MALFORMED_FRAME");
  expect(error.message).toBe("Relay WebSocket returned a non-binary frame");
});

test("subscribe() closes the socket via the generator's cleanup when the consumer stops iterating without aborting", async () => {
  const sockets: FakeRelaySocket[] = [];
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    webSocket: trackingSocketConstructor(sockets),
  });
  const controller = new AbortController();
  const frames: RelayFrame[] = [];
  const stream = relay.subscribe(subscribeRequest(), controller.signal);
  const consuming = (async (): Promise<void> => {
    for await (const frame of stream) {
      frames.push(frame);
      break;
    }
  })();
  await flushMicrotasks();
  const socket = sockets[0];
  if (socket === undefined) throw new Error("expected a socket to have been created");

  socket.emitMessage(envelopeFrameBytes(1n, "message-1"));
  await consuming;
  expect(frames).toHaveLength(1);
  expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Subscription closed" }]);
});

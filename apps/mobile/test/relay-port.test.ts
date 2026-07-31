import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  AckRequestSchema,
  AckResponseSchema,
  DeliveredEnvelopeSchema,
  EncryptedSnapshotSchema,
  GetSnapshotRequestSchema,
  GetSnapshotResponseSchema,
  RelayFrameSchema,
  ResetRequiredSchema,
  SealedEnvelopeSchema,
} from "@pocket-omp/proto/relay/v1";
import {
  MobileWebSocketRelayPort,
  RelayConnectionError,
  type RelayFetch,
  type RelayResetInfo,
  type RelaySocket,
  type RelaySocketEvent,
} from "../src/relay-port";

// ---------------------------------------------------------------------------
// Fake WebSocket: starts already OPEN (skips the connecting-handshake branch,
// which is exercised implicitly and mirrors an already-proven pattern from
// packages/relay-client) so tests can drive frames immediately.
// ---------------------------------------------------------------------------
class FakeWebSocket implements RelaySocket {
  public binaryType = "";
  public readyState = 1;
  public readonly sent: Uint8Array[] = [];
  public closedWith: { readonly code?: number; readonly reason?: string } | undefined;
  readonly #listeners = new Map<string, Set<(event: RelaySocketEvent) => void>>();

  public constructor(
    public readonly url: string,
    public readonly protocols: readonly string[],
  ) {}

  public send(data: Uint8Array): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
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

  public dispatch(type: string): void {
    this.#emit(type, { data: undefined });
  }

  #emit(type: string, event: RelaySocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// All of this suite's protobuf endpoints (snapshot, ack) are always called
// with a binary body; only relay-ticket.ts's JSON request uses a string
// body. Narrowing here (rather than an `as Uint8Array` cast) keeps the
// mismatch-with-reality case a loud test failure instead of a silent unsafe
// assertion.
function bodyBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (!(body instanceof Uint8Array)) throw new Error("expected a binary request body");
  return body;
}

interface FetchCall {
  readonly url: string;
  readonly init: Partial<NonNullable<Parameters<RelayFetch>[1]>>;
}

function relayFrameEnvelopeBytes(
  serverSequence: bigint,
  routeId: string,
  messageId: string,
): Uint8Array {
  return toBinary(
    RelayFrameSchema,
    create(RelayFrameSchema, {
      body: {
        case: "envelope",
        value: create(DeliveredEnvelopeSchema, {
          serverSequence,
          envelope: create(SealedEnvelopeSchema, {
            messageId,
            routeId,
            senderDeviceId: "host-device",
            recipientDeviceId: "mobile-device-1",
            clientSequence: 1n,
            createdAtMs: 1n,
            expiresAtMs: 2n,
            keyId: "key-1",
            nonce: new Uint8Array(24),
            ciphertext: new Uint8Array([1, 2, 3]),
          }),
        }),
      },
    }),
  );
}

function relayFrameResetBytes(
  reason: string,
  latestSnapshotId: string,
  earliest: bigint,
): Uint8Array {
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

// A fetch stub for tests that only ever need the ticket-issuing request to
// succeed (no snapshot/ack traffic exercised).
async function ticketOnlyFetch(): Promise<Response> {
  return Response.json({
    ticket: "ticket-value",
    relay_origin: "https://relay.example",
    expires_at_ms: 9_999_999_999,
    route_epoch: "1",
  });
}

// A fetch stub covering both the ticket request and a single snapshot fetch
// that reports coversThroughSequence=42, used by the fresh-cursor subscribe
// test below.
async function ticketAndSnapshotFetch(
  input: string | URL,
  init?: Parameters<RelayFetch>[1],
): Promise<Response> {
  const url = input.toString();
  if (url === "https://control.example/v1/relay-tickets") return ticketOnlyFetch();
  if (url === "https://relay.example/v1/relay/snapshot") {
    const body = fromBinary(GetSnapshotRequestSchema, bodyBytes(init?.body));
    expect(body.recipientDeviceId).toBe("mobile-device-1");
    return new Response(
      toBinary(
        GetSnapshotResponseSchema,
        create(GetSnapshotResponseSchema, {
          snapshot: create(EncryptedSnapshotSchema, {
            snapshotId: "snapshot-1",
            recipientDeviceId: "mobile-device-1",
            routeId: "route-1",
            coversThroughSequence: 42n,
            createdAtMs: 1n,
            expiresAtMs: 2n,
            keyId: "key-1",
            nonce: new Uint8Array(24),
            ciphertext: new Uint8Array([1]),
          }),
        }),
      ),
      { status: 200, headers: { "content-type": "application/protobuf" } },
    );
  }
  throw new Error(`unexpected fetch to ${url}`);
}

describe("MobileWebSocketRelayPort", () => {
  test("issueTicket() posts the device credential and returns a fresh generation per call", async () => {
    const calls: FetchCall[] = [];
    const fetchStub = async (
      input: string | URL,
      init?: Parameters<RelayFetch>[1],
    ): Promise<Response> => {
      const url = input.toString();
      calls.push({ url, init: init ?? {} });
      return Response.json({
        ticket: "ticket-value",
        relay_origin: "https://relay.example",
        expires_at_ms: 9_999_999_999,
        route_epoch: "1",
      });
    };
    const port = new MobileWebSocketRelayPort({
      fetch: fetchStub,
      webSocket: FakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    const first = await port.issueTicket();
    const second = await port.issueTicket();
    expect(first.ticket).toBe("ticket-value");
    expect(second.ticket).toBe("ticket-value");
    // A fresh generation is minted on every issueTicket() call even though
    // RelayTicketClient caches the underlying ticket value itself (it is
    // still within its refresh margin), since generation is this port's own
    // per-connection-attempt id, independent of ticket freshness.
    expect(first.generation).not.toBe(second.generation);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://control.example/v1/relay-tickets");
    expect(calls[0]?.init.method).toBe("POST");
  });

  test("acknowledge() posts to /v1/relay/ack with the recipient device id and server sequence", async () => {
    const calls: FetchCall[] = [];
    const fetchStub = async (
      input: string | URL,
      init?: Parameters<RelayFetch>[1],
    ): Promise<Response> => {
      const url = input.toString();
      calls.push({ url, init: init ?? {} });
      if (url === "https://control.example/v1/relay-tickets") {
        return Response.json({
          ticket: "ticket-value",
          relay_origin: "https://relay.example",
          expires_at_ms: 9_999_999_999,
          route_epoch: "1",
        });
      }
      if (url === "https://relay.example/v1/relay/ack") {
        const body = fromBinary(AckRequestSchema, bodyBytes(init?.body));
        expect(body.recipientDeviceId).toBe("mobile-device-1");
        expect(body.serverSequence).toBe(42n);
        return new Response(
          toBinary(AckResponseSchema, create(AckResponseSchema, { acceptedServerSequence: 42n })),
          { status: 200, headers: { "content-type": "application/protobuf" } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
    const port = new MobileWebSocketRelayPort({
      fetch: fetchStub,
      webSocket: FakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    await port.issueTicket();
    await port.acknowledge(42n);
    const ackCall = calls.find((call) => call.url === "https://relay.example/v1/relay/ack");
    if (ackCall === undefined) throw new Error("expected an ack request");
    expect(ackCall.init.headers?.authorization).toBe("Bearer ticket-value");
  });

  test("acknowledge() before issueTicket() throws RelayConnectionError", async () => {
    const port = new MobileWebSocketRelayPort({
      fetch: () => Promise.reject(new Error("should not be called")),
      webSocket: FakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    await expect(port.acknowledge(1n)).rejects.toBeInstanceOf(RelayConnectionError);
  });

  test("subscribe() with a fresh cursor fetches a snapshot first, then connects with after=<snapshot cursor> and the correct subprotocol", async () => {
    const sockets: FakeWebSocket[] = [];
    class TrackedFakeWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    const port = new MobileWebSocketRelayPort({
      fetch: ticketAndSnapshotFetch,
      webSocket: TrackedFakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 0n,
      signal: controller.signal,
    });
    const nextPromise = iterator.next();
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);
    const socket = sockets[0];
    if (socket === undefined) throw new Error("expected a socket to have been created");
    const url = new URL(socket.url);
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/v1/relay/subscribe");
    expect(url.searchParams.get("recipient_device_id")).toBe("mobile-device-1");
    expect(url.searchParams.get("after")).toBe("42");
    expect(url.searchParams.get("generation")).toBe(ticket.generation);
    expect(socket.protocols).toEqual(["pocket-omp-relay", "pocket-omp-ticket.ticket-value"]);

    socket.emitMessage(relayFrameEnvelopeBytes(43n, "route-1", "message-1"));
    const step = await nextPromise;
    expect(step.done).toBeFalse();
    if (step.done === true) throw new Error("expected a frame");
    expect(step.value.serverSequence).toBe(43n);
    expect(step.value.generation).toBe(ticket.generation);
    expect(step.value.eventId).toBe("message-1");
    controller.abort();
    await iterator.next();
  });

  test("subscribe() with an already-known cursor does not fetch a snapshot up front", async () => {
    const sockets: FakeWebSocket[] = [];
    class TrackedFakeWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    let ticketCalls = 0;
    const fetchStub = async (input: string | URL): Promise<Response> => {
      const url = input.toString();
      if (url === "https://control.example/v1/relay-tickets") {
        ticketCalls += 1;
        return Response.json({
          ticket: "ticket-value",
          relay_origin: "https://relay.example",
          expires_at_ms: 9_999_999_999,
          route_epoch: "1",
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
    const port = new MobileWebSocketRelayPort({
      fetch: fetchStub,
      webSocket: TrackedFakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 100n,
      signal: controller.signal,
    });
    void iterator.next();
    await flushMicrotasks();
    expect(ticketCalls).toBe(1);
    const socket = sockets[0];
    if (socket === undefined) throw new Error("expected a socket to have been created");
    expect(new URL(socket.url).searchParams.get("after")).toBe("100");
    controller.abort();
    await iterator.next();
  });

  test("a ResetRequired frame triggers a snapshot re-fetch, invokes onResetRequired, and transparently resumes the stream on a new connection", async () => {
    const sockets: FakeWebSocket[] = [];
    class TrackedFakeWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    let snapshotCalls = 0;
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
        snapshotCalls += 1;
        const body = fromBinary(GetSnapshotRequestSchema, bodyBytes(init?.body));
        expect(body.snapshotId).toBe("snapshot-latest");
        return new Response(
          toBinary(
            GetSnapshotResponseSchema,
            create(GetSnapshotResponseSchema, {
              snapshot: create(EncryptedSnapshotSchema, {
                snapshotId: "snapshot-latest",
                recipientDeviceId: "mobile-device-1",
                routeId: "route-1",
                coversThroughSequence: 200n,
                createdAtMs: 1n,
                expiresAtMs: 2n,
                keyId: "key-1",
                nonce: new Uint8Array(24),
                ciphertext: new Uint8Array([1]),
              }),
            }),
          ),
          { status: 200, headers: { "content-type": "application/protobuf" } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
    const resets: RelayResetInfo[] = [];
    const port = new MobileWebSocketRelayPort({
      fetch: fetchStub,
      webSocket: TrackedFakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
      onResetRequired: (info) => resets.push(info),
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 100n,
      signal: controller.signal,
    });
    const firstNext = iterator.next();
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);
    const firstSocket = sockets[0];
    if (firstSocket === undefined) throw new Error("expected first socket");

    firstSocket.emitMessage(relayFrameResetBytes("retention gap", "snapshot-latest", 150n));
    // Draining the reset frame, closing the socket, refetching the snapshot,
    // and opening a second socket all happen without yielding a frame, so
    // `firstNext` only settles once the second connection is ready for its
    // first frame -- give it room to run before asserting.
    await flushMicrotasks();
    await flushMicrotasks();

    expect(snapshotCalls).toBe(1);
    expect(resets).toEqual([
      {
        reason: "retention gap",
        latestSnapshotId: "snapshot-latest",
        earliestAvailableSequence: 150n,
      },
    ]);
    expect(sockets).toHaveLength(2);
    const secondSocket = sockets[1];
    if (secondSocket === undefined) throw new Error("expected a second socket after the reset");
    expect(new URL(secondSocket.url).searchParams.get("after")).toBe("200");

    secondSocket.emitMessage(relayFrameEnvelopeBytes(201n, "route-1", "message-2"));
    const step = await firstNext;
    expect(step.done).toBeFalse();
    if (step.done === true) throw new Error("expected a frame after the reset");
    expect(step.value.serverSequence).toBe(201n);
    // The generation tag is stable across the reset-driven reconnect.
    expect(step.value.generation).toBe(ticket.generation);
    controller.abort();
    await iterator.next();
  });

  test("consecutive ResetRequired frames with no frame streamed in between are backed off, unlike a single isolated reset", async () => {
    const sockets: FakeWebSocket[] = [];
    class TrackedFakeWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    let snapshotCalls = 0;
    const fetchStub = async (input: string | URL): Promise<Response> => {
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
        snapshotCalls += 1;
        return new Response(
          toBinary(
            GetSnapshotResponseSchema,
            create(GetSnapshotResponseSchema, {
              snapshot: create(EncryptedSnapshotSchema, {
                snapshotId: `snapshot-${snapshotCalls}`,
                recipientDeviceId: "mobile-device-1",
                routeId: "route-1",
                coversThroughSequence: BigInt(100 * snapshotCalls),
                createdAtMs: 1n,
                expiresAtMs: 2n,
                keyId: "key-1",
                nonce: new Uint8Array(24),
                ciphertext: new Uint8Array([1]),
              }),
            }),
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
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 100n,
      signal: controller.signal,
    });
    void iterator.next();
    await flushMicrotasks();
    expect(sockets).toHaveLength(1);

    // First reset: nothing has streamed yet, but it's the first in a row --
    // reconnects immediately, same as the isolated-reset case above.
    sockets[0]?.emitMessage(relayFrameResetBytes("gap", "", 0n));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(sockets).toHaveLength(2);

    // Second reset in a row with still no frame streamed through -- this is
    // where backoff must kick in instead of reconnecting immediately.
    sockets[1]?.emitMessage(relayFrameResetBytes("gap", "", 0n));
    await flushMicrotasks();
    await flushMicrotasks();
    expect(sockets).toHaveLength(2); // Not yet -- the backoff delay hasn't elapsed.

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sockets).toHaveLength(3);

    controller.abort();
    await iterator.next();
  });

  test("subscribe() before issueTicket() throws RelayConnectionError", async () => {
    const port = new MobileWebSocketRelayPort({
      fetch: () => Promise.reject(new Error("should not be called")),
      webSocket: FakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    const iterator = port.subscribe({
      ticket: "t",
      afterServerSequence: 0n,
      signal: new AbortController().signal,
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(RelayConnectionError);
  });

  test("a malformed frame surfaces as a rejection and closes the socket with code 1002", async () => {
    const sockets: FakeWebSocket[] = [];
    class TrackedFakeWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    }
    const port = new MobileWebSocketRelayPort({
      fetch: ticketOnlyFetch,
      webSocket: TrackedFakeWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 100n,
      signal: controller.signal,
    });
    const nextPromise = iterator.next();
    await flushMicrotasks();
    const socket = sockets[0];
    if (socket === undefined) throw new Error("expected a socket to have been created");
    socket.emitMessage(new Uint8Array([0xff, 0xff, 0xff]));
    await expect(nextPromise).rejects.toBeTruthy();
    expect(socket.closedWith?.code).toBe(1002);
  });

  test("a WebSocket handshake that never settles is bounded by connectTimeoutMs instead of hanging forever", async () => {
    class NeverConnectsWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        this.readyState = 0; // CONNECTING, and stays there.
      }
    }
    const port = new MobileWebSocketRelayPort({
      fetch: ticketOnlyFetch,
      webSocket: NeverConnectsWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
      connectTimeoutMs: 20,
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 100n,
      signal: controller.signal,
    });
    await expect(iterator.next()).rejects.toBeInstanceOf(RelayConnectionError);
  });

  test("aborting the signal while the WebSocket is still connecting unblocks the subscription immediately", async () => {
    class NeverConnectsWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        this.readyState = 0; // CONNECTING, and stays there absent an abort.
      }
    }
    const port = new MobileWebSocketRelayPort({
      fetch: ticketOnlyFetch,
      webSocket: NeverConnectsWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
      // Long enough that only the abort -- not the timeout -- could plausibly
      // resolve this within the test.
      connectTimeoutMs: 60_000,
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 100n,
      signal: controller.signal,
    });
    const nextPromise = iterator.next();
    await flushMicrotasks();
    controller.abort();
    const step = await nextPromise;
    expect(step.done).toBeTrue();
  });

  test("a WebSocket error while still connecting surfaces as a rejection", async () => {
    class ConnectingFakeWebSocket extends FakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        this.readyState = 0;
      }

      public failToConnect(): void {
        this.dispatch("error");
      }
    }
    const created: ConnectingFakeWebSocket[] = [];
    class CapturingWebSocket extends ConnectingFakeWebSocket {
      public constructor(url: string, protocols: readonly string[]) {
        super(url, protocols);
        created.push(this);
      }
    }
    const port = new MobileWebSocketRelayPort({
      fetch: ticketOnlyFetch,
      webSocket: CapturingWebSocket,
      now: () => 0,
      controlUrl: "https://control.example",
      credential: { deviceId: "mobile-device-1", credential: `poc_dev_${"a1".repeat(32)}` },
    });
    const ticket = await port.issueTicket();
    const controller = new AbortController();
    const iterator = port.subscribe({
      ticket: ticket.ticket,
      afterServerSequence: 100n,
      signal: controller.signal,
    });
    const nextPromise = iterator.next();
    await flushMicrotasks();
    created[0]?.failToConnect();
    await expect(nextPromise).rejects.toBeInstanceOf(RelayConnectionError);
  });
});

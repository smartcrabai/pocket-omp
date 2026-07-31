// Covers WorkerRelayClient's HTTP RPCs (publish/acknowledge/putSnapshot/
// getSnapshot) plus the shared constructor and ticket-resolution behavior
// they all go through (`#call`/`#resolveTicket` in src/index.ts).
// `subscribe()` (the WebSocket half) is covered separately in
// subscribe.test.ts.

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import {
  AckRequestSchema,
  AckResponseSchema,
  AcceptedSchema,
  EncryptedSnapshotSchema,
  GetSnapshotRequestSchema,
  GetSnapshotResponseSchema,
  NotificationHint,
  OutboundEnvelopeSchema,
  Priority,
  PublishRequestSchema,
  PublishResponseSchema,
  PublishResultSchema,
  PutSnapshotRequestSchema,
  PutSnapshotResponseSchema,
  RejectedSchema,
} from "@pocket-omp/proto/relay/v1";
import { RelayClientError, WorkerRelayClient, type RelayFetch } from "../src/index";

const BASE_URL = "https://relay.example.com";

interface FetchCall {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly body: Uint8Array | undefined;
  readonly signal: AbortSignal | undefined;
}

// A fetch fake that records every call it receives and defers the response
// to `respond`, mirroring the injected-fake style used throughout this repo
// (e.g. apps/mobile/test/relay-port.test.ts) rather than stubbing the
// global `fetch`.
function recordingFetch(calls: FetchCall[], respond: (call: FetchCall) => Response): RelayFetch {
  return async (input, init) => {
    const call: FetchCall = {
      url: input.toString(),
      method: init?.method,
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  };
}

// Every RPC this client makes always sends a binary protobuf body; narrowing
// here (rather than an `as Uint8Array` cast) keeps a mismatch-with-reality a
// loud test failure instead of a silently unsafe assertion.
function bodyBytes(body: Uint8Array | undefined): Uint8Array {
  if (!(body instanceof Uint8Array)) throw new Error("expected a binary request body");
  return body;
}

function outboundEnvelope(messageId: string) {
  return create(OutboundEnvelopeSchema, {
    messageId,
    routeId: "route-1",
    senderDeviceId: "host-1",
    recipientDeviceId: "mobile-1",
    clientSequence: 1n,
    createdAtMs: 1_000n,
    expiresAtMs: 2_000n,
    keyId: "key-1",
    nonce: new Uint8Array(24),
    ciphertext: new Uint8Array([1, 2, 3]),
    priority: Priority.NORMAL,
    notificationHint: NotificationHint.NONE,
  });
}

function protobufResponse(bytes: Uint8Array): Response {
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/protobuf" },
  });
}

// A fixed non-2xx response, for the REQUEST_FAILED tests below.
function errorFetch(status: number, body: string): RelayFetch {
  return async () => new Response(body, { status });
}

// A 2xx response whose body isn't valid protobuf, for the decode-error test
// below.
async function malformedProtobufFetch(): Promise<Response> {
  return new Response(new Uint8Array([0xff, 0xff, 0xff]), { status: 200 });
}

test("constructor rejects a non-HTTPS baseUrl", () => {
  expect(() => new WorkerRelayClient({ baseUrl: "http://relay.example.com" })).toThrow(
    RelayClientError,
  );
});

test("constructor rejects an unparsable baseUrl", () => {
  expect(() => new WorkerRelayClient({ baseUrl: "not a url" })).toThrow(RelayClientError);
});

test("constructor accepts an https baseUrl", () => {
  expect(() => new WorkerRelayClient({ baseUrl: BASE_URL })).not.toThrow();
});

test("publish() posts protobuf to /v1/relay/publish with a bearer ticket and decodes mixed accepted/rejected results", async () => {
  const calls: FetchCall[] = [];
  const envelopeA = outboundEnvelope("message-a");
  const envelopeB = outboundEnvelope("message-b");
  const fetchStub = recordingFetch(calls, (call) => {
    const body = fromBinary(PublishRequestSchema, bodyBytes(call.body));
    expect(body.envelopes).toEqual([envelopeA, envelopeB]);
    expect(body.ackServerSequence).toBe(9n);
    return protobufResponse(
      toBinary(
        PublishResponseSchema,
        create(PublishResponseSchema, {
          results: [
            create(PublishResultSchema, {
              messageId: "message-a",
              outcome: {
                case: "accepted",
                value: create(AcceptedSchema, { serverSequence: 5n, duplicate: false }),
              },
            }),
            create(PublishResultSchema, {
              messageId: "message-b",
              outcome: {
                case: "rejected",
                value: create(RejectedSchema, { code: "ROUTE_NOT_GRANTED", message: "nope" }),
              },
            }),
          ],
          acceptedAckServerSequence: 9n,
        }),
      ),
    );
  });
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    fetch: fetchStub,
    ticket: "ticket-value",
  });
  const response = await relay.publish(
    create(PublishRequestSchema, { envelopes: [envelopeA, envelopeB], ackServerSequence: 9n }),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(`${BASE_URL}/v1/relay/publish`);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers?.["content-type"]).toBe("application/protobuf");
  expect(calls[0]?.headers?.accept).toBe("application/protobuf");
  expect(calls[0]?.headers?.authorization).toBe("Bearer ticket-value");

  expect(response.acceptedAckServerSequence).toBe(9n);
  expect(response.results[0]?.outcome).toEqual({
    case: "accepted",
    value: create(AcceptedSchema, { serverSequence: 5n, duplicate: false }),
  });
  expect(response.results[1]?.outcome).toEqual({
    case: "rejected",
    value: create(RejectedSchema, { code: "ROUTE_NOT_GRANTED", message: "nope" }),
  });
});

test("publish() omits the Authorization header when no ticket is configured", async () => {
  const calls: FetchCall[] = [];
  const fetchStub = recordingFetch(calls, () =>
    protobufResponse(
      toBinary(
        PublishResponseSchema,
        create(PublishResponseSchema, { results: [], acceptedAckServerSequence: 0n }),
      ),
    ),
  );
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: fetchStub });
  await relay.publish(create(PublishRequestSchema, { envelopes: [outboundEnvelope("m1")] }));
  expect(calls[0]?.headers?.authorization).toBeUndefined();
});

test("publish() resolves a synchronous ticket() provider into the Authorization header", async () => {
  const calls: FetchCall[] = [];
  const fetchStub = recordingFetch(calls, () =>
    protobufResponse(
      toBinary(
        PublishResponseSchema,
        create(PublishResponseSchema, { results: [], acceptedAckServerSequence: 0n }),
      ),
    ),
  );
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    fetch: fetchStub,
    ticket: () => "sync-ticket",
  });
  await relay.publish(create(PublishRequestSchema, { envelopes: [outboundEnvelope("m1")] }));
  expect(calls[0]?.headers?.authorization).toBe("Bearer sync-ticket");
});

test("publish() resolves an async ticket() provider into the Authorization header", async () => {
  const calls: FetchCall[] = [];
  const fetchStub = recordingFetch(calls, () =>
    protobufResponse(
      toBinary(
        PublishResponseSchema,
        create(PublishResponseSchema, { results: [], acceptedAckServerSequence: 0n }),
      ),
    ),
  );
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    fetch: fetchStub,
    ticket: () => Promise.resolve("async-ticket"),
  });
  await relay.publish(create(PublishRequestSchema, { envelopes: [outboundEnvelope("m1")] }));
  expect(calls[0]?.headers?.authorization).toBe("Bearer async-ticket");
});

test("publish() forwards the caller's AbortSignal to fetch and omits it when absent", async () => {
  const calls: FetchCall[] = [];
  const fetchStub = recordingFetch(calls, () =>
    protobufResponse(
      toBinary(
        PublishResponseSchema,
        create(PublishResponseSchema, { results: [], acceptedAckServerSequence: 0n }),
      ),
    ),
  );
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: fetchStub });
  const controller = new AbortController();
  await relay.publish(
    create(PublishRequestSchema, { envelopes: [outboundEnvelope("m1")] }),
    controller.signal,
  );
  await relay.publish(create(PublishRequestSchema, { envelopes: [outboundEnvelope("m2")] }));
  expect(calls[0]?.signal).toBe(controller.signal);
  expect(calls[1]?.signal).toBeUndefined();
});

test("publish() surfaces a non-2xx response as REQUEST_FAILED without leaking the ticket", async () => {
  const ticket = "super-secret-ticket-value";
  const fetchStub = errorFetch(503, "mailbox unavailable");
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: fetchStub, ticket });
  const error = await relay
    .publish(create(PublishRequestSchema, { envelopes: [outboundEnvelope("m1")] }))
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RelayClientError);
  if (!(error instanceof RelayClientError)) throw new Error("expected a RelayClientError");
  expect(error.code).toBe("REQUEST_FAILED");
  expect(error.message).toContain("503");
  expect(error.message).toContain("mailbox unavailable");
  expect(error.message).not.toContain(ticket);
});

test("publish() propagates a decode error when the 2xx response body isn't valid protobuf", async () => {
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: malformedProtobufFetch });
  const error = await relay
    .publish(create(PublishRequestSchema, { envelopes: [outboundEnvelope("m1")] }))
    .catch((caught: unknown) => caught);
  expect(error).toBeTruthy();
});

test("acknowledge() posts to /v1/relay/ack and decodes the AckResponse", async () => {
  const calls: FetchCall[] = [];
  const fetchStub = recordingFetch(calls, (call) => {
    const body = fromBinary(AckRequestSchema, bodyBytes(call.body));
    expect(body.recipientDeviceId).toBe("mobile-1");
    expect(body.serverSequence).toBe(42n);
    return protobufResponse(
      toBinary(AckResponseSchema, create(AckResponseSchema, { acceptedServerSequence: 42n })),
    );
  });
  const relay = new WorkerRelayClient({
    baseUrl: BASE_URL,
    fetch: fetchStub,
    ticket: "ticket-value",
  });
  const response = await relay.acknowledge(
    create(AckRequestSchema, { recipientDeviceId: "mobile-1", serverSequence: 42n }),
  );
  expect(calls[0]?.url).toBe(`${BASE_URL}/v1/relay/ack`);
  expect(calls[0]?.method).toBe("POST");
  expect(calls[0]?.headers?.authorization).toBe("Bearer ticket-value");
  expect(response.acceptedServerSequence).toBe(42n);
});

test("acknowledge() surfaces a non-2xx response as REQUEST_FAILED without leaking the ticket", async () => {
  const ticket = "another-secret-ticket";
  const fetchStub = errorFetch(403, "device mismatch");
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: fetchStub, ticket });
  const error = await relay
    .acknowledge(create(AckRequestSchema, { recipientDeviceId: "mobile-1", serverSequence: 1n }))
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(RelayClientError);
  if (!(error instanceof RelayClientError)) throw new Error("expected a RelayClientError");
  expect(error.code).toBe("REQUEST_FAILED");
  expect(error.message).not.toContain(ticket);
});

test("putSnapshot() PUTs to /v1/relay/snapshot and decodes the returned snapshot_id", async () => {
  const calls: FetchCall[] = [];
  const snapshot = create(EncryptedSnapshotSchema, {
    snapshotId: "snapshot-1",
    recipientDeviceId: "mobile-1",
    routeId: "route-1",
    coversThroughSequence: 100n,
    createdAtMs: 1n,
    expiresAtMs: 2n,
    keyId: "key-1",
    nonce: new Uint8Array(24),
    ciphertext: new Uint8Array([1]),
  });
  const fetchStub = recordingFetch(calls, (call) => {
    const body = fromBinary(PutSnapshotRequestSchema, bodyBytes(call.body));
    expect(body.snapshot).toEqual(snapshot);
    return protobufResponse(
      toBinary(
        PutSnapshotResponseSchema,
        create(PutSnapshotResponseSchema, { snapshotId: "snapshot-1" }),
      ),
    );
  });
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: fetchStub });
  const response = await relay.putSnapshot(create(PutSnapshotRequestSchema, { snapshot }));
  expect(calls[0]?.url).toBe(`${BASE_URL}/v1/relay/snapshot`);
  expect(calls[0]?.method).toBe("PUT");
  expect(response.snapshotId).toBe("snapshot-1");
});

test("getSnapshot() POSTs to /v1/relay/snapshot and round-trips an omitted snapshot_id", async () => {
  const calls: FetchCall[] = [];
  const fetchStub = recordingFetch(calls, (call) => {
    const body = fromBinary(GetSnapshotRequestSchema, bodyBytes(call.body));
    expect(body.recipientDeviceId).toBe("mobile-1");
    expect(body.snapshotId).toBeUndefined();
    return protobufResponse(
      toBinary(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema, {})),
    );
  });
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: fetchStub });
  const response = await relay.getSnapshot(
    create(GetSnapshotRequestSchema, { recipientDeviceId: "mobile-1" }),
  );
  expect(calls[0]?.url).toBe(`${BASE_URL}/v1/relay/snapshot`);
  expect(calls[0]?.method).toBe("POST");
  expect(response.snapshot).toBeUndefined();
});

test("getSnapshot() requests a specific snapshot_id and decodes the returned snapshot", async () => {
  const snapshot = create(EncryptedSnapshotSchema, {
    snapshotId: "snapshot-2",
    recipientDeviceId: "mobile-1",
    routeId: "route-1",
    coversThroughSequence: 5n,
    createdAtMs: 1n,
    expiresAtMs: 2n,
    keyId: "key-1",
    nonce: new Uint8Array(24),
    ciphertext: new Uint8Array([9]),
  });
  const calls: FetchCall[] = [];
  const fetchStub = recordingFetch(calls, (call) => {
    const body = fromBinary(GetSnapshotRequestSchema, bodyBytes(call.body));
    expect(body.snapshotId).toBe("snapshot-2");
    return protobufResponse(
      toBinary(GetSnapshotResponseSchema, create(GetSnapshotResponseSchema, { snapshot })),
    );
  });
  const relay = new WorkerRelayClient({ baseUrl: BASE_URL, fetch: fetchStub });
  const response = await relay.getSnapshot(
    create(GetSnapshotRequestSchema, { recipientDeviceId: "mobile-1", snapshotId: "snapshot-2" }),
  );
  expect(response.snapshot).toEqual(snapshot);
});

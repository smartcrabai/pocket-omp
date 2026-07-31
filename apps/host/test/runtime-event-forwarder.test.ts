import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  commandId,
  eventId,
  runId,
  sessionId,
  type AgentDomainEvent,
} from "@pocket-omp/agent-domain";
import type { AgentSessionFactory, AgentSessionPort } from "@pocket-omp/agent-runtime-core";
import {
  encodeRuntimeFrame,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeFrameDecoder,
} from "@pocket-omp/agent-runtime-protocol";
import {
  RuntimeShutdownSchema,
  RuntimeStartSchema,
  type RuntimeFrame,
  RuntimeFrameSchema,
} from "@pocket-omp/proto/runtime/v1";
import {
  decodeSecurePayload,
  decodeTranscriptEvent,
  encodeSecurePayload,
} from "@pocket-omp/session-protocol";

import { RuntimeFrameServer } from "../src/runtime-server";
import {
  buildSessionEvent,
  forwardRuntimeEvent,
  RuntimeEventForwarderError,
  type RuntimeEventFrame,
  type RuntimeEventRelay,
} from "../src/runtime-event-forwarder";

const runtimeId = "runtime-1";
const runtimeGeneration = 7n;

// ---------------------------------------------------------------------------
// Drives the real RuntimeFrameServer (apps/host/src/runtime-server.ts) end to
// end to capture an authentic `event` frame -- byte-for-byte what Runtime
// actually sends on the wire for a given AgentDomainEvent, rather than a
// hand-rolled guess at the encoding (see #forwardEvents/jsonReplacer there).
// ---------------------------------------------------------------------------

async function captureRuntimeEventFrame(event: AgentDomainEvent): Promise<RuntimeEventFrame> {
  const session: AgentSessionPort = {
    sessionId: sessionId("session-test"),
    capabilities: {
      sdkVersion: "1",
      sessionPersistence: true,
      extensionUiKinds: [],
      tools: [],
      steering: false,
      followUp: false,
      compaction: false,
      subagents: false,
      mcp: false,
      lsp: false,
    },
    execute: async () => undefined,
    events: () => oneEvent(event),
    flush: async () => "aa",
    dispose: async () => undefined,
  };
  const factory: AgentSessionFactory = { create: async () => session };
  const output: Uint8Array[] = [];
  const server = new RuntimeFrameServer(
    {
      runtimeId,
      runtimeGeneration,
      nowMs: () => 100n,
      monotonicMs: () => 50n,
      factory: async () => factory,
    },
    { write: async (bytes) => void output.push(bytes) },
  );

  await server.run(inputChunks());

  const decoded = decodeAll(output);
  const eventFrame = decoded.find((frame) => frame.payload.case === "event");
  if (eventFrame === undefined || eventFrame.payload.case !== "event") {
    throw new Error("expected RuntimeFrameServer to emit an event frame");
  }
  return {
    eventId: eventFrame.payload.value.eventId,
    kind: eventFrame.payload.value.kind,
    payload: eventFrame.payload.value.payload,
  };
}

async function* oneEvent(event: AgentDomainEvent): AsyncIterable<AgentDomainEvent> {
  yield event;
}

// Same technique as captureRuntimeEventFrame, generalized to a whole sequence
// of AgentDomainEvents queued on one session, for the Host->Mobile
// reconstruction test below (which needs several interleaved message-delta
// events, not just one event).
async function captureRuntimeEventFrames(
  events: readonly AgentDomainEvent[],
): Promise<RuntimeEventFrame[]> {
  let allSent = false;
  const session: AgentSessionPort = {
    sessionId: sessionId("session-test"),
    capabilities: {
      sdkVersion: "1",
      sessionPersistence: true,
      extensionUiKinds: [],
      tools: [],
      steering: false,
      followUp: false,
      compaction: false,
      subagents: false,
      mcp: false,
      lsp: false,
    },
    execute: async () => undefined,
    events: () =>
      manyEvents(events, () => {
        allSent = true;
      }),
    flush: async () => "aa",
    dispose: async () => undefined,
  };
  const factory: AgentSessionFactory = { create: async () => session };
  const output: Uint8Array[] = [];
  const server = new RuntimeFrameServer(
    {
      runtimeId,
      runtimeGeneration,
      nowMs: () => 100n,
      monotonicMs: () => 50n,
      factory: async () => factory,
    },
    { write: async (bytes) => void output.push(bytes) },
  );

  await server.run(inputChunksWaitingFor(() => allSent));

  const decoded = decodeAll(output);
  return decoded.flatMap((frame) =>
    frame.payload.case === "event"
      ? [
          {
            eventId: frame.payload.value.eventId,
            kind: frame.payload.value.kind,
            payload: frame.payload.value.payload,
          },
        ]
      : [],
  );
}

// Signals onDone() only once every queued event has been fully processed by
// the consuming for-await loop (#forwardEvents in runtime-server.ts): an
// async generator only resumes past its last `yield` -- reaching the code
// after this `for` loop -- once the consumer asks for one more value, which
// for-await only does after it has entirely finished handling the previous
// one. So by the time onDone() runs, every event's frame has already been
// written to the sink.
async function* manyEvents(
  events: readonly AgentDomainEvent[],
  onDone: () => void,
): AsyncIterable<AgentDomainEvent> {
  for (const event of events) yield event;
  onDone();
}

async function* inputChunks(): AsyncIterable<Uint8Array> {
  yield encodeRuntimeFrame(
    hostFrame("start-1", {
      case: "start",
      value: create(RuntimeStartSchema, { cwd: "/workspace", allowedTools: [] }),
    }),
  );
  // Gives the detached #forwardEvents() loop a couple of microtask turns to
  // read the one queued event and write its frame before shutdown is sent.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  yield encodeRuntimeFrame(
    hostFrame("shutdown-1", {
      case: "shutdown",
      value: create(RuntimeShutdownSchema, { reason: "test", deadlineMs: 1_000n }),
    }),
  );
}

function hostFrame(requestId: string, payload: RuntimeFrame["payload"]): RuntimeFrame {
  return create(RuntimeFrameSchema, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeGeneration,
    requestId,
    createdAtMs: 1n,
    payload,
  });
}

function decodeAll(chunks: readonly Uint8Array[]): RuntimeFrame[] {
  const decoder = new RuntimeFrameDecoder();
  const frames = chunks.flatMap((chunk) => decoder.push(chunk));
  decoder.finish();
  return frames;
}

// Used only by captureRuntimeEventFrames, whose fake session can emit any
// number of queued events: rather than guessing how many microtask turns are
// enough (as the single-event inputChunks above hard-codes), this polls
// until the caller reports every event has actually been written, so the
// shutdown frame can never race ahead and truncate the capture regardless of
// how many events are queued.
async function* inputChunksWaitingFor(isDone: () => boolean): AsyncIterable<Uint8Array> {
  yield encodeRuntimeFrame(
    hostFrame("start-1", {
      case: "start",
      value: create(RuntimeStartSchema, { cwd: "/workspace", allowedTools: [] }),
    }),
  );
  while (!isDone()) {
    // oxlint-disable-next-line no-await-in-loop -- Polling until the fake session has finished emitting every queued event; shutdown must never be sent before that.
    await Promise.resolve();
  }
  yield encodeRuntimeFrame(
    hostFrame("shutdown-1", {
      case: "shutdown",
      value: create(RuntimeShutdownSchema, { reason: "test", deadlineMs: 1_000n }),
    }),
  );
}

// ---------------------------------------------------------------------------
// buildSessionEvent: real wire round-trip
// ---------------------------------------------------------------------------

describe("buildSessionEvent (real Runtime wire round-trip)", () => {
  test("reconstructs all EventMetadata fields, preserving bigints, when runId and causationCommandId are present", async () => {
    const domainEvent: AgentDomainEvent = {
      kind: "agent-started",
      eventId: eventId("event-1"),
      sessionId: sessionId("session-1"),
      runId: runId("run-1"),
      revision: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
      createdAtMs: 1_700_000_000_123n,
      runtimeGeneration,
      causationCommandId: commandId("command-1"),
    };
    const frame = await captureRuntimeEventFrame(domainEvent);
    const sessionEvent = buildSessionEvent("host-1", frame);

    expect(sessionEvent.eventId).toBe("event-1");
    expect(sessionEvent.sessionId).toBe("session-1");
    expect(sessionEvent.runId).toBe("run-1");
    expect(sessionEvent.revision).toBe(9_007_199_254_740_993n);
    expect(typeof sessionEvent.revision).toBe("bigint");
    expect(sessionEvent.createdAtMs).toBe(1_700_000_000_123n);
    expect(sessionEvent.runtimeGeneration).toBe(runtimeGeneration);
    expect(sessionEvent.causationCommandId).toBe("command-1");
    expect(sessionEvent.hostId).toBe("host-1");
    expect(sessionEvent.ownershipEpoch).toBeUndefined();
    expect(sessionEvent.kind).toBe("agent-started");
    // payload is no longer the RuntimeEvent's raw JSON bytes -- it is the
    // kind-specific remainder re-encoded as a session-protocol
    // TranscriptEvent (see runtime-event-forwarder.ts's module doc comment).
    expect(decodeTranscriptEvent(sessionEvent.kind, sessionEvent.payload)).toEqual({
      kind: "agent-started",
      runId: "run-1",
    });
  });

  test("omits runId and causationCommandId when the domain event doesn't carry them", async () => {
    const domainEvent: AgentDomainEvent = {
      kind: "message-started",
      eventId: eventId("event-2"),
      sessionId: sessionId("session-1"),
      revision: 1n,
      createdAtMs: 5n,
      runtimeGeneration,
      messageId: "message-1",
    };
    const frame = await captureRuntimeEventFrame(domainEvent);
    const sessionEvent = buildSessionEvent("host-1", frame);

    expect(sessionEvent.runId).toBeUndefined();
    expect(sessionEvent.causationCommandId).toBeUndefined();
    expect(sessionEvent.kind).toBe("message-started");
    expect(decodeTranscriptEvent(sessionEvent.kind, sessionEvent.payload)).toEqual({
      kind: "message-started",
      messageId: "message-1",
    });
  });

  test("round-trips through encodeSecurePayload/decodeSecurePayload as a valid session-event", async () => {
    const domainEvent: AgentDomainEvent = {
      kind: "todo-updated",
      eventId: eventId("event-3"),
      sessionId: sessionId("session-1"),
      revision: 2n,
      createdAtMs: 6n,
      runtimeGeneration,
      items: [{ id: "1", text: "do it", status: "pending" }],
    };
    const frame = await captureRuntimeEventFrame(domainEvent);
    const sessionEvent = buildSessionEvent("host-1", frame);
    const encoded = encodeSecurePayload({
      capabilitySet: "v1",
      body: { kind: "session-event", value: sessionEvent },
    });
    const decoded = decodeSecurePayload(encoded);
    if (decoded.body.kind !== "session-event") throw new Error("expected session-event");
    expect(decoded.body.value).toEqual(sessionEvent);
  });
});

// ---------------------------------------------------------------------------
// buildSessionEvent: malformed payload handling (hand-constructed, since
// runtime-server.ts never actually produces these -- they exercise the
// parser's defenses against a corrupted/adversarial event frame).
// ---------------------------------------------------------------------------

function frameWith(json: unknown): RuntimeEventFrame {
  return {
    eventId: "event-1",
    kind: "agent-started",
    payload: new TextEncoder().encode(JSON.stringify(json)),
  };
}

describe("buildSessionEvent (malformed payloads)", () => {
  test("rejects invalid JSON", () => {
    expect(() =>
      buildSessionEvent("host-1", {
        eventId: "e1",
        kind: "k",
        payload: new TextEncoder().encode("{"),
      }),
    ).toThrow(RuntimeEventForwarderError);
  });

  test("rejects a non-object JSON payload", () => {
    expect(() => buildSessionEvent("host-1", frameWith([1, 2, 3]))).toThrow(
      RuntimeEventForwarderError,
    );
  });

  test("rejects a missing sessionId", () => {
    expect(() =>
      buildSessionEvent(
        "host-1",
        frameWith({ revision: "1", createdAtMs: "0", runtimeGeneration: "0" }),
      ),
    ).toThrow(RuntimeEventForwarderError);
  });

  test("rejects a non-stringified revision", () => {
    expect(() =>
      buildSessionEvent(
        "host-1",
        frameWith({ sessionId: "s1", revision: 1, createdAtMs: "0", runtimeGeneration: "0" }),
      ),
    ).toThrow(RuntimeEventForwarderError);
  });

  test("rejects a kind this build's TranscriptEvent oneof has no case for", () => {
    expect(() =>
      buildSessionEvent("host-1", {
        eventId: "e1",
        kind: "a-future-kind-this-build-does-not-know",
        payload: new TextEncoder().encode(
          JSON.stringify({
            sessionId: "s1",
            revision: "1",
            createdAtMs: "0",
            runtimeGeneration: "0",
          }),
        ),
      }),
    ).toThrow(RuntimeEventForwarderError);
  });

  test("rejects a recognized kind that is missing its kind-specific field", () => {
    // Valid EventMetadata, but "agent-started" additionally requires runId,
    // which is absent here.
    expect(() =>
      buildSessionEvent(
        "host-1",
        frameWith({ sessionId: "s1", revision: "1", createdAtMs: "0", runtimeGeneration: "0" }),
      ),
    ).toThrow(RuntimeEventForwarderError);
  });
});

// ---------------------------------------------------------------------------
// forwardRuntimeEvent: relay wiring
// ---------------------------------------------------------------------------

function validFrame(): RuntimeEventFrame {
  return {
    eventId: "event-1",
    kind: "message-started",
    payload: new TextEncoder().encode(
      JSON.stringify({
        sessionId: "session-1",
        revision: "1",
        createdAtMs: "0",
        runtimeGeneration: "0",
        messageId: "message-1",
      }),
    ),
  };
}

interface EnqueueCall {
  readonly recipientDeviceId: string;
  readonly plaintext: Uint8Array;
}

function fakeRelay(overrides: Partial<RuntimeEventRelay> = {}): {
  readonly relay: RuntimeEventRelay;
  readonly calls: EnqueueCall[];
  readonly errors: unknown[];
} {
  const calls: EnqueueCall[] = [];
  const errors: unknown[] = [];
  const relay: RuntimeEventRelay = {
    coordinator: {
      enqueue: async (recipientDeviceId: string, plaintext: Uint8Array) => {
        calls.push({ recipientDeviceId, plaintext });
        return { duplicate: false };
      },
    },
    hostId: "host-1",
    recipientDeviceId: () => "mobile-1",
    onForwardError: (error) => errors.push(error),
    ...overrides,
  };
  return { relay, calls, errors };
}

describe("forwardRuntimeEvent", () => {
  test("does nothing when relay is undefined", async () => {
    await forwardRuntimeEvent(validFrame(), undefined);
    // No assertion possible beyond "did not throw"; the point is a no-op.
  });

  test("enqueues an encoded session-event SecurePayload addressed to the resolved recipient", async () => {
    const { relay, calls, errors } = fakeRelay();
    await forwardRuntimeEvent(validFrame(), relay);

    expect(errors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.recipientDeviceId).toBe("mobile-1");
    const decoded = decodeSecurePayload(calls[0]?.plaintext ?? new Uint8Array());
    if (decoded.body.kind !== "session-event") throw new Error("expected session-event");
    expect(decoded.body.value.eventId).toBe("event-1");
    expect(decoded.body.value.hostId).toBe("host-1");
    expect(decoded.body.value.sessionId).toBe("session-1");
  });

  test("reports NO_RECIPIENT and never calls enqueue when no recipient device id is known yet", async () => {
    const { relay, calls, errors } = fakeRelay({ recipientDeviceId: () => undefined });
    await forwardRuntimeEvent(validFrame(), relay);

    expect(calls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RuntimeEventForwarderError);
    expect(errors[0]).toMatchObject({ code: "NO_RECIPIENT" });
  });

  test("reports a malformed-event error and never calls enqueue for an unparseable payload", async () => {
    const { relay, calls, errors } = fakeRelay();
    const malformed: RuntimeEventFrame = {
      eventId: "event-1",
      kind: "message-started",
      payload: new TextEncoder().encode("not json"),
    };
    await forwardRuntimeEvent(malformed, relay);

    expect(calls).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RuntimeEventForwarderError);
    expect(errors[0]).toMatchObject({ code: "MALFORMED_EVENT" });
  });

  test("reports (rather than throws) when the relay coordinator's enqueue rejects", async () => {
    const errors: unknown[] = [];
    const relay: RuntimeEventRelay = {
      coordinator: {
        enqueue: async () => {
          throw new Error("relay unavailable");
        },
      },
      hostId: "host-1",
      recipientDeviceId: () => "mobile-1",
      onForwardError: (error) => errors.push(error),
    };

    await forwardRuntimeEvent(validFrame(), relay); // must not throw
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(errors[0]).toMatchObject({ message: "relay unavailable" });
  });

  test("swallows forwarding failures silently when onForwardError is not provided", async () => {
    const relay: RuntimeEventRelay = {
      coordinator: { enqueue: async () => ({ duplicate: false }) },
      hostId: "host-1",
      recipientDeviceId: () => undefined,
    };
    await forwardRuntimeEvent(validFrame(), relay); // must not throw despite NO_RECIPIENT
  });
});

// ---------------------------------------------------------------------------
// Host -> Mobile, end to end: drives the real RuntimeFrameServer to capture
// authentic wire bytes for a whole interleaved multi-message run, builds
// SessionEvents from them exactly as forwardRuntimeEvent does, decodes each
// with the same session-protocol codec Mobile decodes with (there is no
// separate Mobile-specific decoder -- @pocket-omp/session-protocol is the
// one implementation both sides share), and reconstructs each message's text
// by grouping message-delta events by messageId and concatenating in
// ascending SessionEvent.revision order. apps/mobile/src/session-view.ts's
// reconstructTranscript (unit-tested independently in
// apps/mobile/test/session-view.test.ts) implements this same grouping
// rule for the UI; it cannot be imported directly from a Host test (Host has
// no dependency on the Mobile app), so this test re-derives the reduction
// here to prove the *wire format* -- Host's real encode output decoding
// correctly end to end -- independently of that UI-layer implementation.
// ---------------------------------------------------------------------------

describe("Host -> Mobile: real wire bytes reconstruct transcript text", () => {
  test("concatenates interleaved message-delta events by messageId in revision order, even when they arrive out of order", async () => {
    const base = {
      eventId: eventId("placeholder"), // overwritten per-event below
      sessionId: sessionId("session-test"),
      createdAtMs: 1_700_000_000_000n,
      runtimeGeneration,
    } as const;

    // Logical (revision) order:
    //   1: message-started   msg-A
    //   2: message-started   msg-B
    //   3: message-delta     msg-B "World "
    //   4: message-delta     msg-A "Hello, "
    //   5: message-delta     msg-A "there!"
    //   6: message-delta     msg-B "wide."
    //   7: message-completed msg-A
    //   8: message-completed msg-B
    // Fed into captureRuntimeEventFrames in a deliberately shuffled order,
    // so only sorting by SessionEvent.revision (not arrival/array order)
    // can recover the correct text.
    const events: AgentDomainEvent[] = [
      {
        ...base,
        eventId: eventId("e1"),
        kind: "message-started",
        revision: 1n,
        messageId: "msg-A",
      },
      {
        ...base,
        eventId: eventId("e4"),
        kind: "message-delta",
        revision: 4n,
        messageId: "msg-A",
        delta: "Hello, ",
      },
      {
        ...base,
        eventId: eventId("e2"),
        kind: "message-started",
        revision: 2n,
        messageId: "msg-B",
      },
      {
        ...base,
        eventId: eventId("e6"),
        kind: "message-delta",
        revision: 6n,
        messageId: "msg-B",
        delta: "wide.",
      },
      {
        ...base,
        eventId: eventId("e3"),
        kind: "message-delta",
        revision: 3n,
        messageId: "msg-B",
        delta: "World ",
      },
      {
        ...base,
        eventId: eventId("e7"),
        kind: "message-completed",
        revision: 7n,
        messageId: "msg-A",
      },
      {
        ...base,
        eventId: eventId("e5"),
        kind: "message-delta",
        revision: 5n,
        messageId: "msg-A",
        delta: "there!",
      },
      {
        ...base,
        eventId: eventId("e8"),
        kind: "message-completed",
        revision: 8n,
        messageId: "msg-B",
      },
    ];

    const frames = await captureRuntimeEventFrames(events);
    expect(frames).toHaveLength(events.length);

    const sessionEvents = frames
      .map((frame) => buildSessionEvent("host-1", frame))
      .toSorted((left, right) => (left.revision < right.revision ? -1 : 1));

    const textByMessageId = new Map<string, string>();
    for (const sessionEvent of sessionEvents) {
      const body = decodeTranscriptEvent(sessionEvent.kind, sessionEvent.payload);
      if (body.kind !== "message-delta") continue;
      textByMessageId.set(body.messageId, (textByMessageId.get(body.messageId) ?? "") + body.delta);
    }

    expect(textByMessageId.get("msg-A")).toBe("Hello, there!");
    expect(textByMessageId.get("msg-B")).toBe("World wide.");
  });

  test("round-trips every non-delta kind's structured fields through the real wire, not just message text", async () => {
    const base = {
      sessionId: sessionId("session-test"),
      createdAtMs: 1_700_000_000_000n,
      runtimeGeneration,
    } as const;
    const events: AgentDomainEvent[] = [
      {
        ...base,
        eventId: eventId("e1"),
        kind: "agent-started",
        revision: 1n,
        runId: runId("run-1"),
      },
      {
        ...base,
        eventId: eventId("e2"),
        kind: "tool-started",
        revision: 2n,
        toolCallId: "call-1",
        toolName: "read_file",
        display: { path: "README.md" },
      },
      {
        ...base,
        eventId: eventId("e3"),
        kind: "todo-updated",
        revision: 3n,
        items: [{ id: "1", text: "Ship it", status: "in-progress" }],
      },
      { ...base, eventId: eventId("e4"), kind: "agent-ended", revision: 4n, runId: runId("run-1") },
    ];

    const frames = await captureRuntimeEventFrames(events);
    const decoded = frames
      .map((frame) => buildSessionEvent("host-1", frame))
      .map((sessionEvent) => decodeTranscriptEvent(sessionEvent.kind, sessionEvent.payload));

    expect(decoded[0]).toEqual({ kind: "agent-started", runId: "run-1" });
    expect(decoded[1]).toEqual({
      kind: "tool-started",
      toolCallId: "call-1",
      toolName: "read_file",
      displayJson: JSON.stringify({ path: "README.md" }),
    });
    expect(decoded[2]).toEqual({
      kind: "todo-updated",
      items: [{ id: "1", text: "Ship it", status: "in-progress" }],
    });
    expect(decoded[3]).toEqual({ kind: "agent-ended", runId: "run-1" });
  });
});

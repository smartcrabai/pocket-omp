import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  OmpCapabilityManifestSchema,
  RuntimeCommandAcceptedSchema,
  RuntimeCommandResultSchema,
  RuntimeEventSchema,
  RuntimeFaultSchema,
  RuntimeFrameSchema,
  RuntimeHelloSchema,
  RuntimeReadySchema,
  type RuntimeFrame,
} from "@pocket-omp/proto/runtime/v1";

import { RuntimeFrameRouter, RuntimeFrameRouterError } from "../src/runtime-frame-router";

// Minimal push-based AsyncIterator<RuntimeFrame> standing in for
// RuntimeProcessClient's real stdout-backed frame stream: push() feeds a
// frame (or lets an already-pending next() resolve immediately), close()
// ends the stream, fail() makes any future next() reject.
class FakeFrameSource implements AsyncIterator<RuntimeFrame> {
  private readonly queued: RuntimeFrame[] = [];
  private readonly waiting: Array<{
    readonly resolve: (result: IteratorResult<RuntimeFrame>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private error: unknown;

  public push(pushedFrame: RuntimeFrame): void {
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(pushedFrame);
    else waiter.resolve({ done: false, value: pushedFrame });
  }

  public close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  // Rejects any next() call already blocked waiting for a frame, not just
  // future ones -- mirrors packages/agent-runtime-client's real
  // AsyncFrameQueue.fail(), which does the same for a genuine stdout decode
  // error arriving while the router's reader loop is parked in next().
  public fail(error: unknown): void {
    this.error = error;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  public next(): Promise<IteratorResult<RuntimeFrame>> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
    if (this.error !== undefined) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
}

const runtimeId = "runtime-1";
const runtimeGeneration = 1n;

function frame(payload: RuntimeFrame["payload"], requestId?: string): RuntimeFrame {
  return create(RuntimeFrameSchema, {
    protocolVersion: 1,
    runtimeId,
    runtimeGeneration,
    ...(requestId === undefined ? {} : { requestId }),
    createdAtMs: 1n,
    payload,
  });
}

function helloFrame(): RuntimeFrame {
  return frame({ case: "hello", value: create(RuntimeHelloSchema, {}) });
}

function readyFrame(requestId: string, sessionId = "session-1"): RuntimeFrame {
  return frame(
    {
      case: "ready",
      value: create(RuntimeReadySchema, {
        capabilities: create(OmpCapabilityManifestSchema, {}),
        sessionId,
        sessionFingerprint: "abc",
      }),
    },
    requestId,
  );
}

function eventFrame(eventId: string): RuntimeFrame {
  return frame({
    case: "event",
    value: create(RuntimeEventSchema, {
      eventId,
      kind: "message-started",
      payload: new Uint8Array(),
    }),
  });
}

function commandAcceptedFrame(requestId: string, commandId = "command-1"): RuntimeFrame {
  return frame(
    { case: "commandAccepted", value: create(RuntimeCommandAcceptedSchema, { commandId }) },
    requestId,
  );
}

function commandResultFrame(
  requestId: string,
  success: boolean,
  commandId = "command-1",
): RuntimeFrame {
  return frame(
    {
      case: "commandResult",
      value: create(RuntimeCommandResultSchema, { commandId, success, code: "OK", message: "" }),
    },
    requestId,
  );
}

function faultFrame(code = "INTERNAL", message = "boom"): RuntimeFrame {
  return frame({
    case: "fault",
    value: create(RuntimeFaultSchema, { code, message, processMustExit: true }),
  });
}

describe("RuntimeFrameRouter", () => {
  test("routes event frames to onEvent while a request/response wait is pending, and still resolves the response", async () => {
    const source = new FakeFrameSource();
    const events: string[] = [];
    const router = new RuntimeFrameRouter({
      frames: source,
      onEvent: (received) => {
        if (received.payload.case === "event") events.push(received.payload.value.eventId);
      },
    });

    const waiting = router.waitFor("ready", "req-1");
    source.push(eventFrame("event-1"));
    source.push(readyFrame("req-1"));

    const resolved = await waiting;
    expect(resolved.payload.case).toBe("ready");
    expect(events).toEqual(["event-1"]);

    await router.stop();
  });

  test("preserves strict arrival order across interleaved events and sequential request/response waits", async () => {
    const source = new FakeFrameSource();
    const log: string[] = [];
    const router = new RuntimeFrameRouter({
      frames: source,
      onEvent: (received) => {
        if (received.payload.case === "event") log.push(`event:${received.payload.value.eventId}`);
      },
    });

    const readyWait = router.waitFor("ready", "req-1");
    source.push(eventFrame("e1"));
    source.push(readyFrame("req-1"));
    await readyWait;
    log.push("ready-resolved");

    const acceptedWait = router.waitFor("commandAccepted", "req-2");
    source.push(eventFrame("e2"));
    source.push(commandAcceptedFrame("req-2"));
    await acceptedWait;
    log.push("accepted-resolved");

    const resultWait = router.waitFor("commandResult", "req-2");
    source.push(eventFrame("e3"));
    source.push(commandResultFrame("req-2", true));
    await resultWait;
    log.push("result-resolved");

    expect(log).toEqual([
      "event:e1",
      "ready-resolved",
      "event:e2",
      "accepted-resolved",
      "event:e3",
      "result-resolved",
    ]);

    await router.stop();
  });

  test("skips frames of a different case or requestId without resolving the pending wait", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });

    const waiting = router.waitFor("commandResult", "req-2");
    source.push(commandAcceptedFrame("req-2")); // wrong case
    source.push(commandResultFrame("req-1", true)); // wrong requestId
    source.push(commandResultFrame("req-2", false));

    const resolved = await waiting;
    if (resolved.payload.case !== "commandResult") throw new Error("expected commandResult");
    expect(resolved.payload.value.success).toBe(false);

    await router.stop();
  });

  test("a fault frame immediately rejects the currently pending wait", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });

    const waiting = router.waitFor("ready", "req-1");
    source.push(faultFrame("RUNTIME_CRASH", "agent runtime crashed"));

    await expect(waiting).rejects.toMatchObject({
      code: "FAULT",
      message: "RUNTIME_CRASH: agent runtime crashed",
    });

    await router.stop();
  });

  test("a fault frame with nobody waiting is delivered once to the very next waitFor() call", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });

    source.push(faultFrame());
    // Give the reader loop a turn to actually process the pushed frame
    // before anyone calls waitFor (mirrors a fault arriving with no request
    // in flight).
    await Promise.resolve();
    await Promise.resolve();

    await expect(router.waitFor("ready", "req-1")).rejects.toBeInstanceOf(RuntimeFrameRouterError);

    // The fault was consumed exactly once; a subsequent, unrelated wait
    // resolves normally against a real matching frame.
    const nextWait = router.waitFor("hello");
    source.push(helloFrame());
    await expect(nextWait).resolves.toMatchObject({ payload: { case: "hello" } });

    await router.stop();
  });

  test("two response frames that arrive back-to-back before either wait is registered are not dropped (abortRuntime's commandAccepted/commandResult race)", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });

    // Mirrors host-daemon.ts's abortRuntime: it sends one command and then
    // awaits two response frames back to back with no I/O between them, so
    // Runtime's reply can already contain both frames before the second
    // waitFor() call has registered. Push both, then let the reader loop
    // actually consume them -- with nobody registered yet, they must be
    // buffered rather than silently dropped.
    source.push(commandAcceptedFrame("req-2"));
    source.push(commandResultFrame("req-2", true));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const accepted = await router.waitFor("commandAccepted", "req-2", 50);
    expect(accepted.payload.case).toBe("commandAccepted");
    const result = await router.waitFor("commandResult", "req-2", 50);
    if (result.payload.case !== "commandResult") throw new Error("expected commandResult");
    expect(result.payload.value.success).toBe(true);

    await router.stop();
  });

  test("a timeout rejects the wait and does not wedge subsequent, unrelated waits", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });

    await expect(router.waitFor("ready", "req-1", 15)).rejects.toMatchObject({ code: "TIMEOUT" });

    // A frame matching the abandoned wait arrives late; it must not
    // incorrectly resolve a later, unrelated wait.
    source.push(readyFrame("req-1"));
    const nextWait = router.waitFor("commandAccepted", "req-2");
    source.push(commandAcceptedFrame("req-2"));
    await expect(nextWait).resolves.toMatchObject({ requestId: "req-2" });

    await router.stop();
  });

  test("stream end permanently fails the current and all future waits", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });

    const waiting = router.waitFor("ready", "req-1");
    source.close();
    await expect(waiting).rejects.toMatchObject({ code: "STREAM_ENDED" });

    // A later wait fails immediately too, without waiting out its timeout.
    const started = Date.now();
    await expect(router.waitFor("ready", "req-1", 5_000)).rejects.toMatchObject({
      code: "STREAM_ENDED",
    });
    expect(Date.now() - started).toBeLessThan(1_000);

    await router.stop();
  });

  test("an underlying stream read failure fails the current and future waits", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });

    const waiting = router.waitFor("ready", "req-1");
    source.fail(new Error("stdout decode error"));
    await expect(waiting).rejects.toThrow("stdout decode error");

    await router.stop();
  });

  test("stop() resolves promptly even while a read is still blocked on the underlying source, and halts routing", async () => {
    const source = new FakeFrameSource();
    let eventCount = 0;
    const router = new RuntimeFrameRouter({
      frames: source,
      onEvent: () => {
        eventCount += 1;
      },
    });

    // Nothing has been pushed, so the reader loop is blocked inside
    // source.next(); stop() must not hang waiting for it.
    await router.stop();

    // Frames pushed after stop() are never read.
    source.push(eventFrame("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(eventCount).toBe(0);
  });

  test("an onEvent that throws is caught and reported via onEventError, without breaking subsequent routing", async () => {
    const source = new FakeFrameSource();
    const forwardErrors: unknown[] = [];
    const router = new RuntimeFrameRouter({
      frames: source,
      onEvent: () => {
        throw new Error("forwarding failed");
      },
      onEventError: (error) => forwardErrors.push(error),
    });

    const waiting = router.waitFor("ready", "req-1");
    source.push(eventFrame("e1"));
    source.push(readyFrame("req-1"));
    await waiting;

    expect(forwardErrors).toHaveLength(1);
    expect(forwardErrors[0]).toBeInstanceOf(Error);
    expect(forwardErrors[0]).toMatchObject({ message: "forwarding failed" });

    await router.stop();
  });

  test("waitFor rejects with BUSY if a second call is made while one is already pending", async () => {
    const source = new FakeFrameSource();
    const router = new RuntimeFrameRouter({ frames: source, onEvent: () => undefined });
    const first = router.waitFor("ready", "req-1");
    await expect(router.waitFor("ready", "req-2")).rejects.toMatchObject({ code: "BUSY" });

    // The first wait is unaffected and still resolves normally.
    source.push(readyFrame("req-1"));
    await expect(first).resolves.toMatchObject({ payload: { case: "ready" } });

    await router.stop();
  });
});

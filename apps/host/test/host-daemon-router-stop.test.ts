import { create } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import {
  RuntimeEventSchema,
  RuntimeFrameSchema,
  RuntimeHelloSchema,
  type RuntimeFrame,
} from "@pocket-omp/proto/runtime/v1";

import { RuntimeFrameRouter } from "../src/runtime-frame-router";

// host-daemon.ts's startRuntime and close() are RuntimeFrameRouter.stop()'s
// only callers (startRuntime's hello-wait-timeout, protocol-version-mismatch,
// and ready-frame-rejection failure paths, plus close()'s catch-block
// fallback), but startRuntime/close()/shutdownRuntime are not exported and
// always spawn a real Agent Runtime subprocess -- there is no
// dependency-injection seam to unit-test them directly. See
// apps/host/test/fixtures/daemon-handshake-failure-smoke.ts and
// daemon-shutdown-failure-smoke.ts for the real-subprocess proofs that these
// failure paths are actually reached and surface the right HostDaemonError
// (or, for close(), don't hang). What a real subprocess *can't* isolate is
// the specific guarantee those call sites all lean on:
// RuntimeProcessClient.stderr()/dispose(), which those call sites await
// immediately before or after router.stop(), only resolve once the fake
// process has fully exited -- which itself already ends the frame stream
// naturally, masking whether router.stop() specifically is what halted the
// pump. This file isolates that guarantee directly against
// RuntimeFrameRouter's real implementation, using the same push-based fake
// AsyncIterator as runtime-frame-router.test.ts's FakeFrameSource, with each
// test shaped after one of host-daemon.ts's call sites.
class FakeFrameSource implements AsyncIterator<RuntimeFrame> {
  private readonly queued: RuntimeFrame[] = [];
  private readonly waiting: Array<{
    readonly resolve: (result: IteratorResult<RuntimeFrame>) => void;
  }> = [];

  public push(pushedFrame: RuntimeFrame): void {
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(pushedFrame);
    else waiter.resolve({ done: false, value: pushedFrame });
  }

  public next(): Promise<IteratorResult<RuntimeFrame>> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
    return new Promise((resolve) => this.waiting.push({ resolve }));
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

function eventFrame(id: string): RuntimeFrame {
  return frame({
    case: "event",
    value: create(RuntimeEventSchema, {
      eventId: id,
      kind: "message-started",
      payload: new Uint8Array(),
    }),
  });
}

describe("RuntimeFrameRouter.stop() at host-daemon.ts's cleanup call sites", () => {
  test("startRuntime's hello-wait-timeout failure path: router.stop() halts routing even though the Runtime process is never disposed on this path", async () => {
    const source = new FakeFrameSource();
    let eventCount = 0;
    const router = new RuntimeFrameRouter({
      frames: source,
      onEvent: () => {
        eventCount += 1;
      },
    });

    // Mirrors `hello = await nextFrame(router, "hello")` timing out.
    await expect(router.waitFor("hello", undefined, 15)).rejects.toMatchObject({ code: "TIMEOUT" });
    // Mirrors startRuntime's catch block: `await router.stop()`. Unlike the
    // protocol-mismatch/ready-rejection paths, this one never disposes
    // `client`, so router.stop() is the *only* thing that can stop the
    // pump -- if it were dropped, a slow Runtime that eventually does speak
    // would still be routed by an abandoned connection's reader loop.
    await router.stop();

    source.push(eventFrame("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(eventCount).toBe(0);
  });

  test("startRuntime's protocol-version-mismatch failure path: router.stop() halts routing right after Host rejects a non-overlapping hello", async () => {
    const source = new FakeFrameSource();
    let eventCount = 0;
    const router = new RuntimeFrameRouter({
      frames: source,
      onEvent: () => {
        eventCount += 1;
      },
    });

    const waiting = router.waitFor("hello");
    source.push(
      frame({
        case: "hello",
        value: create(RuntimeHelloSchema, {
          minimumProtocolVersion: 2,
          maximumProtocolVersion: 2,
        }),
      }),
    );
    const hello = await waiting;
    if (hello.payload.case !== "hello") throw new Error("expected hello");
    // Mirrors startRuntime's own version-overlap check; the pass/fail
    // condition itself is host-daemon.ts's, not RuntimeFrameRouter's -- only
    // asserted here so this test fails loudly if it stops describing a
    // mismatched hello.
    expect(hello.payload.value.minimumProtocolVersion).toBeGreaterThan(1);
    // Mirrors `await client[Symbol.asyncDispose](); await router.stop();`.
    await router.stop();

    source.push(eventFrame("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(eventCount).toBe(0);
  });

  test("close()'s catch-block fallback: router.stop() halts routing after shutdownRuntime's snapshot wait times out", async () => {
    const source = new FakeFrameSource();
    let eventCount = 0;
    const router = new RuntimeFrameRouter({
      frames: source,
      onEvent: () => {
        eventCount += 1;
      },
    });

    // Mirrors shutdownRuntime's
    // `await nextFrame(runtime.router, "snapshot", requestId)` timing out
    // before shutdownRuntime reaches its own client.stop()/router.stop()
    // calls.
    await expect(router.waitFor("snapshot", "req-1", 15)).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    // Mirrors close()'s catch block:
    // `await this.#runtime.client[Symbol.asyncDispose]();
    //  await this.#runtime.router.stop();`.
    await router.stop();

    source.push(eventFrame("late"));
    await Promise.resolve();
    await Promise.resolve();
    expect(eventCount).toBe(0);
  });
});

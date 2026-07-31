#!/usr/bin/env bun
// Minimal, hand-rolled fake Agent Runtime process (no RuntimeFrameServer)
// for driving host-daemon.ts's startRuntime/close() failure paths end to
// end. fixtures/fake-runtime.ts cannot do this: RuntimeFrameServer always
// sends one valid, protocol-matching `hello` immediately (see
// runtime-server.ts's `run()`) and always answers `shutdown` with a
// `snapshot`, so it can only ever drive HostDaemon's happy path.
//
// Modes (selected via an argv flag, mirroring fake-runtime.ts's own
// `--emit-event` convention -- a compiled single-file executable's argv
// layout does not reliably match a `bun script.ts arg` layout, so this
// avoids depending on a fixed positional index):
//   --no-hello        Never sends `hello`, driving startRuntime's
//                      hello-wait-timeout failure path (RuntimeFrameRouter's
//                      default 10s wait-for-hello elapses). Exits shortly
//                      after that window has passed, so the parent
//                      RuntimeProcessClient's stderr/exit bookkeeping (which
//                      startRuntime's catch block awaits before it can call
//                      router.stop()) settles instead of hanging the test.
//   --bad-hello        Sends a `hello` whose protocol version range does not
//                      overlap RUNTIME_PROTOCOL_VERSION, driving
//                      startRuntime's protocol-version-mismatch failure
//                      path, then exits.
//   --hang-on-shutdown Completes a normal handshake (valid hello, replies
//                      `ready` to `start`) but never answers a `shutdown`
//                      request, driving close()'s catch-block fallback
//                      (shutdownRuntime's wait for `snapshot` times out
//                      before shutdownRuntime reaches its own
//                      client.stop()/router.stop() calls).
import { create } from "@bufbuild/protobuf";
import {
  encodeRuntimeMessage,
  RuntimeFrameDecoder,
  RUNTIME_PROTOCOL_VERSION,
} from "@pocket-omp/agent-runtime-protocol";
import {
  OmpCapabilityManifestSchema,
  type RuntimeFrame,
  RuntimeFrameSchema,
  RuntimeHelloSchema,
  RuntimeReadySchema,
} from "@pocket-omp/proto/runtime/v1";

const runtimeId = process.env.POCKET_OMP_RUNTIME_ID;
const generationEnv = process.env.POCKET_OMP_RUNTIME_GENERATION;
if (runtimeId === undefined || generationEnv === undefined) {
  throw new Error("Missing runtime fence");
}
const runtimeGeneration = BigInt(generationEnv);
const noHello = process.argv.includes("--no-hello");
const badHello = process.argv.includes("--bad-hello");
const hangOnShutdown = process.argv.includes("--hang-on-shutdown");
if (Number(noHello) + Number(badHello) + Number(hangOnShutdown) !== 1) {
  throw new Error("Expected exactly one of --no-hello, --bad-hello, --hang-on-shutdown");
}

const stdout = Bun.stdout.writer();
async function send(payload: RuntimeFrame["payload"], requestId?: string): Promise<void> {
  const outgoing = create(RuntimeFrameSchema, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeGeneration,
    ...(requestId === undefined ? {} : { requestId }),
    createdAtMs: BigInt(Date.now()),
    payload,
  });
  for (const bytes of encodeRuntimeMessage(outgoing)) stdout.write(bytes);
  await stdout.flush();
}

if (badHello) {
  await send({
    case: "hello",
    value: create(RuntimeHelloSchema, {
      runtimeVersion: "test",
      sdkVersion: "test",
      minimumProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
      maximumProtocolVersion: RUNTIME_PROTOCOL_VERSION + 1,
    }),
  });
  stdout.end();
} else if (noHello) {
  // Longer than RuntimeFrameRouter's default 10s wait-for-hello timeout, so
  // Host genuinely times out rather than observing this process exit first
  // (which would surface as STREAM_ENDED, not TIMEOUT).
  await Bun.sleep(10_300);
  stdout.end();
} else {
  await send({
    case: "hello",
    value: create(RuntimeHelloSchema, {
      runtimeVersion: "test",
      sdkVersion: "test",
      minimumProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      maximumProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    }),
  });
  const decoder = new RuntimeFrameDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    for (const frame of decoder.push(chunk)) {
      if (frame.payload.case === "start") {
        // oxlint-disable-next-line no-await-in-loop -- Frames must be written in arrival order, matching runtime-server.ts's own #handle loop.
        await send(
          {
            case: "ready",
            value: create(RuntimeReadySchema, {
              capabilities: create(OmpCapabilityManifestSchema, {}),
              sessionId: "session-handshake-fixture",
              sessionFingerprint: "deadbeef",
            }),
          },
          frame.requestId,
        );
      }
      // `shutdown` frames are deliberately never answered, to drive
      // close()'s catch-block fallback.
    }
  }
  stdout.end();
}

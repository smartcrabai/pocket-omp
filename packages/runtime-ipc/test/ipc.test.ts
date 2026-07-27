import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { RuntimeFrameSchema, RuntimeHeartbeatSchema } from "@pocket-omp/proto/runtime/v1";
import {
  MAX_RUNTIME_FRAME_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeFrameDecoder,
  encodeRuntimeFrame,
} from "../src/index";

const heartbeat = (runtimeId: string, time: bigint) =>
  create(RuntimeFrameSchema, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId,
    runtimeGeneration: 1n,
    createdAtMs: time,
    payload: {
      case: "heartbeat",
      value: create(RuntimeHeartbeatSchema, { monotonicTimeMs: time }),
    },
  });

test("length-prefixed decoder handles fragmented and coalesced frames", () => {
  const first = encodeRuntimeFrame(heartbeat("runtime-1", 1n));
  const second = encodeRuntimeFrame(heartbeat("runtime-1", 2n));
  const combined = new Uint8Array(first.byteLength + second.byteLength);
  combined.set(first);
  combined.set(second, first.byteLength);
  const decoder = new RuntimeFrameDecoder();
  expect(decoder.push(combined.subarray(0, 2))).toEqual([]);
  expect(decoder.push(combined.subarray(2, first.byteLength + 3))).toHaveLength(1);
  const final = decoder.push(combined.subarray(first.byteLength + 3));
  expect(final).toHaveLength(1);
  expect(final[0]?.payload.case).toBe("heartbeat");
  decoder.finish();
});

test("decoder rejects oversized, empty, malformed, and truncated frames", () => {
  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, MAX_RUNTIME_FRAME_BYTES + 1, false);
  expect(() => new RuntimeFrameDecoder().push(oversized)).toThrow("outside the allowed size");
  expect(() => new RuntimeFrameDecoder().push(new Uint8Array(4))).toThrow(
    "outside the allowed size",
  );
  const malformed = new Uint8Array([0, 0, 0, 1, 0xff]);
  expect(() => new RuntimeFrameDecoder().push(malformed)).toThrow("not valid Protobuf");
  const truncated = new RuntimeFrameDecoder();
  truncated.push(encodeRuntimeFrame(heartbeat("runtime-1", 1n)).subarray(0, 5));
  expect(() => truncated.finish()).toThrow("partial frame");
});

test("frame validation rejects incompatible protocol and missing payload", () => {
  expect(() =>
    encodeRuntimeFrame(
      create(RuntimeFrameSchema, {
        protocolVersion: 2,
        runtimeId: "runtime-1",
        runtimeGeneration: 1n,
        createdAtMs: 1n,
        payload: {
          case: "heartbeat",
          value: create(RuntimeHeartbeatSchema, { monotonicTimeMs: 1n }),
        },
      }),
    ),
  ).toThrow("Unsupported runtime protocol version");
  expect(() =>
    encodeRuntimeFrame(
      create(RuntimeFrameSchema, {
        protocolVersion: 1,
        runtimeId: "runtime-1",
        runtimeGeneration: 1n,
        createdAtMs: 1n,
      }),
    ),
  ).toThrow("payload is required");
});

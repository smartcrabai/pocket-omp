import { create } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import {
  RuntimeEventSchema,
  type RuntimeFrame,
  RuntimeFrameSchema,
} from "@pocket-omp/proto/runtime/v1";
import {
  decodeRuntimeLogicalMessage,
  encodeRuntimeMessage,
  LOGICAL_MESSAGE_MAX_BYTES,
  PHYSICAL_FRAME_MAX_BYTES,
  RUNTIME_PROTOCOL_VERSION,
  RuntimeChunkAssembler,
  RuntimeFrameDecoder,
} from "../src";

test("chunks and reconstructs a logical RuntimeFrame above the physical limit", () => {
  const original = eventFrame(new Uint8Array(PHYSICAL_FRAME_MAX_BYTES + 10_000).fill(0x5a));
  const encoded = encodeRuntimeMessage(original);
  expect(encoded.length).toBeGreaterThan(1);
  expect(encoded.every((value) => value.byteLength <= PHYSICAL_FRAME_MAX_BYTES + 4)).toBe(true);

  const assembler = new RuntimeChunkAssembler();
  let logical: Uint8Array | undefined;
  for (const bytes of encoded) {
    const frames = new RuntimeFrameDecoder().push(bytes);
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.payload.case).toBe("chunk");
    if (frame?.payload.case === "chunk") logical = assembler.accept(frame.payload.value) ?? logical;
  }

  expect(logical).toBeDefined();
  const reconstructed = decodeRuntimeLogicalMessage(logical ?? new Uint8Array());
  expect(reconstructed.payload.case).toBe("event");
  if (reconstructed.payload.case === "event" && original.payload.case === "event") {
    expect(reconstructed.payload.value.payload).toEqual(original.payload.value.payload);
  }
});

test("rejects a logical RuntimeFrame above the 32 MiB limit", () => {
  expect(() => encodeRuntimeMessage(eventFrame(new Uint8Array(LOGICAL_MESSAGE_MAX_BYTES)))).toThrow(
    "logical limit",
  );
});

test("rejects a corrupted chunk hash", () => {
  const encoded = encodeRuntimeMessage(
    eventFrame(new Uint8Array(PHYSICAL_FRAME_MAX_BYTES + 10_000).fill(0x33)),
  );
  const assembler = new RuntimeChunkAssembler();
  for (const [index, bytes] of encoded.entries()) {
    const frame = new RuntimeFrameDecoder().push(bytes)[0];
    if (frame?.payload.case !== "chunk") throw new Error("Expected chunk");
    const chunk = frame.payload.value;
    if (index === encoded.length - 1) chunk.data[0] = (chunk.data[0] ?? 0) ^ 0xff;
    if (index === encoded.length - 1) {
      expect(() => assembler.accept(chunk)).toThrow("hash mismatch");
    } else {
      expect(assembler.accept(chunk)).toBeUndefined();
    }
  }
});

function eventFrame(payload: Uint8Array): RuntimeFrame {
  return create(RuntimeFrameSchema, {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    runtimeId: "runtime-chunk-test",
    runtimeGeneration: 1n,
    eventSequence: 1n,
    createdAtMs: 1n,
    payload: {
      case: "event",
      value: create(RuntimeEventSchema, { eventId: "event-1", kind: "test", payload }),
    },
  });
}

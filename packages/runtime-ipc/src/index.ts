import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { RuntimeFrameSchema, type RuntimeFrame } from "@pocket-omp/proto/runtime/v1";

export const RUNTIME_PROTOCOL_VERSION = 1;
export const MAX_RUNTIME_FRAME_BYTES = 16 * 1024 * 1024;

export function encodeRuntimeFrame(frame: RuntimeFrame): Uint8Array {
  validateRuntimeFrame(frame);
  const body = toBinary(RuntimeFrameSchema, frame);
  if (body.byteLength === 0 || body.byteLength > MAX_RUNTIME_FRAME_BYTES) {
    throw new RuntimeIpcError("FRAME_SIZE", "Runtime frame is outside the allowed size");
  }
  const encoded = new Uint8Array(4 + body.byteLength);
  new DataView(encoded.buffer).setUint32(0, body.byteLength, false);
  encoded.set(body, 4);
  return encoded;
}

export class RuntimeFrameDecoder {
  private pending = new Uint8Array();

  public push(chunk: Uint8Array): readonly RuntimeFrame[] {
    if (chunk.byteLength === 0) return [];
    if (this.pending.byteLength + chunk.byteLength > MAX_RUNTIME_FRAME_BYTES + 4) {
      throw new RuntimeIpcError("BUFFER_LIMIT", "Runtime IPC receive buffer exceeded its limit");
    }
    const combined = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    combined.set(this.pending);
    combined.set(chunk, this.pending.byteLength);
    const frames: RuntimeFrame[] = [];
    let offset = 0;
    while (combined.byteLength - offset >= 4) {
      const length = new DataView(combined.buffer, combined.byteOffset + offset, 4).getUint32(
        0,
        false,
      );
      if (length === 0 || length > MAX_RUNTIME_FRAME_BYTES) {
        throw new RuntimeIpcError("FRAME_SIZE", "Runtime frame is outside the allowed size");
      }
      if (combined.byteLength - offset - 4 < length) break;
      let frame: RuntimeFrame;
      try {
        frame = fromBinary(RuntimeFrameSchema, combined.subarray(offset + 4, offset + 4 + length));
      } catch (error) {
        throw new RuntimeIpcError("INVALID_PROTOBUF", "Runtime frame is not valid Protobuf", {
          cause: error,
        });
      }
      validateRuntimeFrame(frame);
      frames.push(frame);
      offset += 4 + length;
    }
    this.pending = combined.slice(offset);
    return frames;
  }

  public finish(): void {
    if (this.pending.byteLength !== 0) {
      throw new RuntimeIpcError("TRUNCATED_FRAME", "Runtime IPC stream ended in a partial frame");
    }
  }
}

export function validateRuntimeFrame(frame: RuntimeFrame): void {
  if (frame.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new RuntimeIpcError("PROTOCOL_VERSION", "Unsupported runtime protocol version");
  }
  if (!/^[\x21-\x7e]{1,128}$/.test(frame.runtimeId)) {
    throw new RuntimeIpcError("INVALID_RUNTIME_ID", "Invalid runtime ID");
  }
  if (frame.runtimeGeneration === 0n) {
    throw new RuntimeIpcError("INVALID_GENERATION", "Runtime generation must be nonzero");
  }
  if (frame.payload.case === undefined) {
    throw new RuntimeIpcError("MISSING_PAYLOAD", "Runtime frame payload is required");
  }
  if (frame.payload.case === "event" && frame.eventSequence === undefined) {
    throw new RuntimeIpcError("MISSING_SEQUENCE", "Runtime event sequence is required");
  }
}

export class RuntimeIpcError extends Error {
  public constructor(
    public readonly code:
      | "FRAME_SIZE"
      | "BUFFER_LIMIT"
      | "INVALID_PROTOBUF"
      | "TRUNCATED_FRAME"
      | "PROTOCOL_VERSION"
      | "INVALID_RUNTIME_ID"
      | "INVALID_GENERATION"
      | "MISSING_PAYLOAD"
      | "MISSING_SEQUENCE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeIpcError";
  }
}

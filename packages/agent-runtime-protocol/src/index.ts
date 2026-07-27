import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  type RuntimeChunk,
  type RuntimeFrame,
  RuntimeFrameSchema,
} from "@pocket-omp/proto/runtime/v1";

export const PHYSICAL_FRAME_MAX_BYTES = 1_048_576;
export const LOGICAL_MESSAGE_MAX_BYTES = 33_554_432;
export const RUNTIME_PROTOCOL_VERSION = 1;

export function encodeRuntimeFrame(frame: RuntimeFrame): Uint8Array {
  const payload = toBinary(RuntimeFrameSchema, frame);
  if (payload.byteLength > PHYSICAL_FRAME_MAX_BYTES) {
    throw new RuntimeProtocolError("FRAME_TOO_LARGE", "Runtime frame exceeds physical limit");
  }
  const framed = new Uint8Array(4 + payload.byteLength);
  new DataView(framed.buffer, framed.byteOffset, 4).setUint32(0, payload.byteLength, false);
  framed.set(payload, 4);
  return framed;
}

export class RuntimeFrameDecoder {
  readonly #buffer = new Uint8Array(PHYSICAL_FRAME_MAX_BYTES + 4);
  #length = 0;

  public push(input: Uint8Array): RuntimeFrame[] {
    const frames: RuntimeFrame[] = [];
    let offset = 0;
    while (offset < input.byteLength) {
      const remaining = this.#buffer.byteLength - this.#length;
      if (remaining === 0) {
        throw new RuntimeProtocolError("FRAME_TOO_LARGE", "Runtime frame buffer exceeded");
      }
      const copied = Math.min(remaining, input.byteLength - offset);
      this.#buffer.set(input.subarray(offset, offset + copied), this.#length);
      this.#length += copied;
      offset += copied;

      while (this.#length >= 4) {
        const frameLength = new DataView(this.#buffer.buffer, this.#buffer.byteOffset, 4).getUint32(
          0,
          false,
        );
        if (frameLength === 0 || frameLength > PHYSICAL_FRAME_MAX_BYTES) {
          throw new RuntimeProtocolError("FRAME_TOO_LARGE", "Invalid physical frame length");
        }
        if (this.#length < frameLength + 4) break;
        const payload = this.#buffer.slice(4, frameLength + 4);
        let frame: RuntimeFrame;
        try {
          frame = fromBinary(RuntimeFrameSchema, payload);
        } catch (error) {
          throw new RuntimeProtocolError("MALFORMED_FRAME", "Invalid RuntimeFrame protobuf", {
            cause: error,
          });
        }
        validateRuntimeFrame(frame);
        frames.push(frame);
        this.#buffer.copyWithin(0, frameLength + 4, this.#length);
        this.#length -= frameLength + 4;
      }
    }
    return frames;
  }

  public finish(): void {
    if (this.#length !== 0) {
      throw new RuntimeProtocolError("TRUNCATED_FRAME", "Runtime stream ended mid-frame");
    }
  }
}

export function validateRuntimeFrame(frame: RuntimeFrame): void {
  if (frame.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new RuntimeProtocolError("PROTOCOL_UNSUPPORTED", "Unsupported runtime protocol version");
  }
  if (frame.runtimeId.length === 0 || frame.runtimeGeneration === 0n) {
    throw new RuntimeProtocolError("INVALID_FENCE", "Runtime identity or generation is missing");
  }
  if (frame.payload.case === undefined) {
    throw new RuntimeProtocolError("MALFORMED_FRAME", "Runtime payload is missing");
  }
}

interface PendingLogicalMessage {
  readonly totalChunks: number;
  readonly totalSize: bigint;
  readonly logicalHash: Uint8Array;
  readonly chunks: Uint8Array[];
  nextIndex: number;
  receivedSize: number;
}

export class RuntimeChunkAssembler {
  readonly #pending = new Map<string, PendingLogicalMessage>();

  public accept(chunk: RuntimeChunk): Uint8Array | undefined {
    if (
      chunk.logicalMessageId.length === 0 ||
      chunk.totalChunks === 0 ||
      chunk.totalSize === 0n ||
      chunk.totalSize > BigInt(LOGICAL_MESSAGE_MAX_BYTES) ||
      chunk.logicalHash.byteLength !== 32 ||
      chunk.data.byteLength === 0
    ) {
      throw new RuntimeProtocolError("INVALID_CHUNK", "Invalid chunk metadata");
    }
    let pending = this.#pending.get(chunk.logicalMessageId);
    if (pending === undefined) {
      if (chunk.index !== 0) {
        throw new RuntimeProtocolError("OUT_OF_ORDER_CHUNK", "First chunk index must be zero");
      }
      pending = {
        totalChunks: chunk.totalChunks,
        totalSize: chunk.totalSize,
        logicalHash: chunk.logicalHash.slice(),
        chunks: [],
        nextIndex: 0,
        receivedSize: 0,
      };
      this.#pending.set(chunk.logicalMessageId, pending);
    }
    if (
      chunk.index !== pending.nextIndex ||
      chunk.totalChunks !== pending.totalChunks ||
      chunk.totalSize !== pending.totalSize ||
      !constantTimeEqual(chunk.logicalHash, pending.logicalHash)
    ) {
      this.#pending.delete(chunk.logicalMessageId);
      throw new RuntimeProtocolError("OUT_OF_ORDER_CHUNK", "Chunk sequence or metadata changed");
    }
    pending.chunks.push(chunk.data.slice());
    pending.receivedSize += chunk.data.byteLength;
    pending.nextIndex += 1;
    if (pending.receivedSize > Number(pending.totalSize)) {
      this.#pending.delete(chunk.logicalMessageId);
      throw new RuntimeProtocolError("INVALID_CHUNK", "Chunk data exceeds declared size");
    }
    if (pending.nextIndex !== pending.totalChunks) return undefined;
    this.#pending.delete(chunk.logicalMessageId);
    if (pending.receivedSize !== Number(pending.totalSize)) {
      throw new RuntimeProtocolError("INVALID_CHUNK", "Logical message size mismatch");
    }
    const assembled = new Uint8Array(pending.receivedSize);
    let assembledOffset = 0;
    for (const data of pending.chunks) {
      assembled.set(data, assembledOffset);
      assembledOffset += data.byteLength;
    }
    const actualHash = new Uint8Array(Bun.CryptoHasher.hash("sha256", assembled));
    if (!constantTimeEqual(actualHash, pending.logicalHash)) {
      throw new RuntimeProtocolError("HASH_MISMATCH", "Logical message hash mismatch");
    }
    return assembled;
  }

  public cancel(logicalMessageId: string): void {
    this.#pending.delete(logicalMessageId);
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export class RuntimeProtocolError extends Error {
  public constructor(
    public readonly code:
      | "FRAME_TOO_LARGE"
      | "MALFORMED_FRAME"
      | "TRUNCATED_FRAME"
      | "PROTOCOL_UNSUPPORTED"
      | "INVALID_FENCE"
      | "INVALID_CHUNK"
      | "OUT_OF_ORDER_CHUNK"
      | "HASH_MISMATCH",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeProtocolError";
  }
}

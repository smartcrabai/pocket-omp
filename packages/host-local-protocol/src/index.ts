import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { type HostLocalFrame, HostLocalFrameSchema } from "@pocket-omp/proto/hostlocal/v1";

export const HOST_LOCAL_PROTOCOL_VERSION = 1;
export const HOST_LOCAL_FRAME_MAX_BYTES = 1_048_576;

export function encodeHostLocalFrame(frame: HostLocalFrame): Uint8Array {
  validateHostLocalFrame(frame);
  const payload = toBinary(HostLocalFrameSchema, frame);
  if (payload.byteLength > HOST_LOCAL_FRAME_MAX_BYTES) {
    throw new HostLocalProtocolError("FRAME_TOO_LARGE", "Host local frame is too large");
  }
  const result = new Uint8Array(payload.byteLength + 4);
  new DataView(result.buffer).setUint32(0, payload.byteLength, false);
  result.set(payload, 4);
  return result;
}

export function decodeHostLocalFrame(framed: Uint8Array): HostLocalFrame {
  if (framed.byteLength < 5) {
    throw new HostLocalProtocolError("TRUNCATED_FRAME", "Host local frame is truncated");
  }
  const length = new DataView(framed.buffer, framed.byteOffset, 4).getUint32(0, false);
  if (length === 0 || length > HOST_LOCAL_FRAME_MAX_BYTES || framed.byteLength !== length + 4) {
    throw new HostLocalProtocolError("FRAME_TOO_LARGE", "Invalid host local frame length");
  }
  let frame: HostLocalFrame;
  try {
    frame = fromBinary(HostLocalFrameSchema, framed.subarray(4));
  } catch (error) {
    throw new HostLocalProtocolError("MALFORMED_FRAME", "Invalid HostLocalFrame protobuf", {
      cause: error,
    });
  }
  validateHostLocalFrame(frame);
  return frame;
}

export function validateHostLocalFrame(frame: HostLocalFrame): void {
  if (frame.protocolVersion !== HOST_LOCAL_PROTOCOL_VERSION || frame.requestId.length === 0) {
    throw new HostLocalProtocolError("PROTOCOL_UNSUPPORTED", "Invalid host local protocol header");
  }
  if (frame.authenticationProof.byteLength !== 32 || frame.body.case === undefined) {
    throw new HostLocalProtocolError("AUTHENTICATION_FAILED", "Authentication proof is missing");
  }
}

export function authenticationProof(
  secret: Uint8Array,
  requestId: string,
  bodyHash: Uint8Array,
): Uint8Array {
  if (secret.byteLength < 32 || requestId.length === 0 || bodyHash.byteLength !== 32) {
    throw new HostLocalProtocolError("AUTHENTICATION_FAILED", "Invalid authentication inputs");
  }
  const hasher = new Bun.CryptoHasher("sha256", secret);
  hasher.update(new TextEncoder().encode(`pocket-omp/hostlocal/v1\0${requestId}\0`));
  hasher.update(bodyHash);
  return new Uint8Array(hasher.digest());
}

export function verifyAuthenticationProof(
  secret: Uint8Array,
  requestId: string,
  bodyHash: Uint8Array,
  proof: Uint8Array,
): boolean {
  const expected = authenticationProof(secret, requestId, bodyHash);
  if (expected.byteLength !== proof.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < proof.byteLength; index += 1) {
    difference |= (expected[index] ?? 0) ^ (proof[index] ?? 0);
  }
  return difference === 0;
}

export class HostLocalProtocolError extends Error {
  public constructor(
    public readonly code:
      | "FRAME_TOO_LARGE"
      | "TRUNCATED_FRAME"
      | "MALFORMED_FRAME"
      | "PROTOCOL_UNSUPPORTED"
      | "AUTHENTICATION_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostLocalProtocolError";
  }
}

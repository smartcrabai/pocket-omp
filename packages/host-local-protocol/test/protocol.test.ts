import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
  HostLocalFrameSchema,
  PrepareTuiHandoffRequestSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import {
  authenticationProof,
  decodeHostLocalFrame,
  encodeHostLocalFrame,
  verifyAuthenticationProof,
} from "../src/index";

test("authenticated Host-local handoff frames round-trip", () => {
  const secret = new Uint8Array(32).fill(1);
  const bodyHash = new Uint8Array(32).fill(2);
  const proof = authenticationProof(secret, "request-1", bodyHash);
  expect(verifyAuthenticationProof(secret, "request-1", bodyHash, proof)).toBeTrue();
  expect(verifyAuthenticationProof(secret, "request-2", bodyHash, proof)).toBeFalse();
  const frame = create(HostLocalFrameSchema, {
    protocolVersion: 1,
    requestId: "request-1",
    authenticationProof: proof,
    body: {
      case: "prepareTuiHandoff",
      value: create(PrepareTuiHandoffRequestSchema, {
        sessionId: "session-1",
        abortActiveRun: true,
      }),
    },
  });
  expect(decodeHostLocalFrame(encodeHostLocalFrame(frame))).toEqual(frame);
});

test("Host-local protocol rejects unauthenticated and truncated frames", () => {
  const missingProof = create(HostLocalFrameSchema, {
    protocolVersion: 1,
    requestId: "request-1",
    body: {
      case: "prepareTuiHandoff",
      value: create(PrepareTuiHandoffRequestSchema, { sessionId: "session-1" }),
    },
  });
  expect(() => encodeHostLocalFrame(missingProof)).toThrow("Authentication proof is missing");
  expect(() => decodeHostLocalFrame(new Uint8Array([0, 0, 0, 1]))).toThrow("truncated");
  expect(() => authenticationProof(new Uint8Array(3), "request-1", new Uint8Array(32))).toThrow(
    "Invalid authentication inputs",
  );
});

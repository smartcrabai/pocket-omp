import { expect, test } from "bun:test";
import { runtimeId } from "@pocket-omp/agent-domain";
import { transitionOwnership, type OwnershipState } from "../src/index";

test("session ownership follows the single-writer managed TUI handoff", () => {
  let state: OwnershipState = { kind: "idle", epoch: 0n };
  state = transitionOwnership(state, { kind: "acquire-pocket", runtimeId: runtimeId("runtime-1") });
  expect(state).toMatchObject({ kind: "pocket-owned", epoch: 1n });
  state = transitionOwnership(state, { kind: "prepare-handoff" });
  expect(state).toMatchObject({ kind: "handoff-pending", epoch: 2n });
  state = transitionOwnership(state, { kind: "handoff-ready", processId: 42 });
  expect(state).toEqual({ kind: "tui-owned", epoch: 3n, processId: 42 });
  state = transitionOwnership(state, { kind: "managed-tui-exited" });
  expect(state).toEqual({ kind: "verifying", epoch: 4n });
  state = transitionOwnership(state, { kind: "verification-succeeded" });
  expect(state).toEqual({ kind: "idle", epoch: 5n });
});

test("handoff failure rolls back while external writers force explicit conflict recovery", () => {
  const owned = transitionOwnership(
    { kind: "idle", epoch: 0n },
    { kind: "acquire-pocket", runtimeId: runtimeId("runtime-1") },
  );
  const pending = transitionOwnership(owned, { kind: "prepare-handoff" });
  expect(transitionOwnership(pending, { kind: "handoff-failed" })).toEqual({ ...owned, epoch: 3n });
  const conflict = transitionOwnership(owned, {
    kind: "external-writer-detected",
    reason: "fingerprint changed",
  });
  expect(conflict).toMatchObject({ kind: "conflict", reason: "fingerprint changed" });
  expect(transitionOwnership(conflict, { kind: "recover-conflict" })).toEqual({
    kind: "idle",
    epoch: 3n,
  });
  expect(() => transitionOwnership(owned, { kind: "managed-tui-exited" })).toThrow(
    "Invalid ownership transition",
  );
});

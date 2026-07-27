import { expect, test } from "bun:test";
import { sessionId } from "@pocket-omp/agent-domain";
import { decideWorkspacePermission, verifyHostApproval } from "../src/index";

test("permission presets keep dangerous actions gated", () => {
  expect(decideWorkspacePermission({ kind: "safe" }, "read", 1n)).toBe("allow");
  expect(decideWorkspacePermission({ kind: "safe" }, "write", 1n)).toBe("require-mobile-approval");
  expect(decideWorkspacePermission({ kind: "safe" }, "browser", 1n)).toBe("deny");
  expect(decideWorkspacePermission({ kind: "trusted-workspace" }, "write", 1n)).toBe("allow");
  expect(decideWorkspacePermission({ kind: "trusted-workspace" }, "git-destructive", 1n)).toBe(
    "require-mobile-approval",
  );
  expect(
    decideWorkspacePermission(
      { kind: "unattended", locallyEnabled: true, expiresAtMs: 10n },
      "bash",
      10n,
    ),
  ).toBe("allow");
  expect(
    decideWorkspacePermission(
      { kind: "unattended", locallyEnabled: true, expiresAtMs: 10n },
      "bash",
      11n,
    ),
  ).toBe("deny");
});

test("Host approval is bound to session, active route, generation, expiry, and displayed content", () => {
  const pending = {
    approvalRequestId: "approval-1",
    sessionId: sessionId("session-1"),
    routeId: "route-1",
    runtimeGeneration: 2n,
    contentHash: new Uint8Array([1, 2, 3]),
    expiresAtMs: 2_000n,
  };
  const response = {
    approvalRequestId: "approval-1",
    sessionId: sessionId("session-1"),
    routeId: "route-1",
    runtimeGeneration: 2n,
    displayedContentHash: new Uint8Array([1, 2, 3]),
    allow: true,
  };
  expect(verifyHostApproval(pending, response, 1_999n, true)).toBeTrue();
  expect(
    verifyHostApproval(pending, { ...response, runtimeGeneration: 3n }, 1_999n, true),
  ).toBeFalse();
  expect(
    verifyHostApproval(
      pending,
      { ...response, displayedContentHash: new Uint8Array([1, 2, 4]) },
      1_999n,
      true,
    ),
  ).toBeFalse();
  expect(verifyHostApproval(pending, response, 2_001n, true)).toBeFalse();
  expect(verifyHostApproval(pending, response, 1_999n, false)).toBeFalse();
});

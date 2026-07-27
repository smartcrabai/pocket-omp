import { expect, test } from "bun:test";
import {
  AgentRuntimeCore,
  approvalRequestId,
  commandId,
  eventId,
  runId,
  sessionId,
  uiRequestId,
  type AgentDomainEvent,
  type RuntimeCommandEnvelope,
} from "../src/index";

const envelope = (
  command: RuntimeCommandEnvelope["command"],
  issuedAtMs = 1_000n,
  expiresAtMs = 2_000n,
): RuntimeCommandEnvelope => ({ command, issuedAtMs, expiresAtMs });

type EventBody<T extends AgentDomainEvent = AgentDomainEvent> = T extends AgentDomainEvent
  ? Omit<T, "eventId" | "sessionId" | "revision" | "createdAtMs" | "runtimeGeneration">
  : never;

const event = (revision: bigint, body: EventBody): AgentDomainEvent => ({
  eventId: eventId(`event-${revision}`),
  sessionId: sessionId("session-1"),
  revision,
  createdAtMs: 1_000n,
  runtimeGeneration: 1n,
  ...body,
});

test("runtime core enforces run-state transitions and command idempotency", () => {
  const core = new AgentRuntimeCore();
  const prompt = envelope({
    kind: "submit-prompt",
    commandId: commandId("command-1"),
    text: "hello",
  });
  expect(core.decide(prompt, 1_100n)).toEqual({ accepted: true });
  expect(core.decide(prompt, 1_100n)).toEqual({ accepted: false, code: "DUPLICATE" });
  expect(
    core.decide(
      envelope({ kind: "steer", commandId: commandId("command-2"), text: "focus" }),
      1_100n,
    ),
  ).toEqual({
    accepted: false,
    code: "INVALID_STATE",
  });
  core.observe(event(1n, { kind: "agent-started", runId: runId("run-1") }));
  expect(core.runState).toBe("running");
  expect(
    core.decide(
      envelope({ kind: "steer", commandId: commandId("command-2"), text: "focus" }),
      1_100n,
    ),
  ).toEqual({
    accepted: true,
  });
  expect(
    core.decide(envelope({ kind: "compact", commandId: commandId("command-3") }), 1_100n),
  ).toEqual({
    accepted: false,
    code: "INVALID_STATE",
  });
  core.observe(event(2n, { kind: "agent-ended", runId: runId("run-1") }));
  expect(core.runState).toBe("ended");
});

test("runtime core rejects invalid time windows and blank text without consuming command IDs", () => {
  const core = new AgentRuntimeCore();
  const id = commandId("command-1");
  expect(
    core.decide(envelope({ kind: "submit-prompt", commandId: id, text: "hello" }, 3n, 2n), 1n),
  ).toEqual({
    accepted: false,
    code: "INVALID_WINDOW",
  });
  expect(
    core.decide(envelope({ kind: "submit-prompt", commandId: id, text: "hello" }, 1n, 2n), 3n),
  ).toEqual({
    accepted: false,
    code: "EXPIRED",
  });
  expect(
    core.decide(envelope({ kind: "submit-prompt", commandId: id, text: "   " }), 1_100n),
  ).toEqual({
    accepted: false,
    code: "INVALID_CONTENT",
  });
  expect(
    core.decide(envelope({ kind: "submit-prompt", commandId: id, text: "valid" }), 1_100n),
  ).toEqual({ accepted: true });
});

test("approval and UI responses are bound to current displayed content", () => {
  const core = new AgentRuntimeCore();
  const approval = approvalRequestId("approval-1");
  const ui = uiRequestId("ui-1");
  const hash = new Uint8Array([1, 2, 3]);
  core.observe(
    event(1n, {
      kind: "approval-requested",
      approvalRequestId: approval,
      expiresAtMs: 2_000n,
      summary: "run",
      contentHash: hash,
    }),
  );
  core.observe(
    event(2n, {
      kind: "ui-requested",
      uiRequestId: ui,
      uiKind: "confirm",
      expiresAtMs: 2_000n,
      payload: {},
      contentHash: hash,
    }),
  );
  expect(
    core.decide(
      envelope({
        kind: "approval-response",
        commandId: commandId("command-1"),
        approvalRequestId: approval,
        allow: true,
        displayedContentHash: new Uint8Array([9]),
      }),
      1_100n,
    ),
  ).toEqual({ accepted: false, code: "STALE_RESPONSE" });
  expect(
    core.decide(
      envelope({
        kind: "approval-response",
        commandId: commandId("command-1"),
        approvalRequestId: approval,
        allow: true,
        displayedContentHash: hash,
      }),
      1_100n,
    ),
  ).toEqual({ accepted: true });
  expect(
    core.decide(
      envelope(
        {
          kind: "ui-response",
          commandId: commandId("command-2"),
          uiRequestId: ui,
          response: new Uint8Array([1]),
          displayedContentHash: hash,
        },
        1_000n,
        3_000n,
      ),
      2_001n,
    ),
  ).toEqual({ accepted: false, code: "STALE_RESPONSE" });
  expect(() => core.observe(event(2n, { kind: "message-started", messageId: "m1" }))).toThrow(
    "Event revision must increase",
  );
});

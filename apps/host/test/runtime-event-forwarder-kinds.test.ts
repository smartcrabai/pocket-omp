import { describe, expect, test } from "bun:test";
import {
  approvalRequestId,
  eventId,
  runId,
  sessionId,
  uiRequestId,
  type AgentDomainEvent,
} from "@pocket-omp/agent-domain";
import { decodeTranscriptEvent } from "@pocket-omp/session-protocol";

import {
  buildSessionEvent,
  RuntimeEventForwarderError,
  type RuntimeEventFrame,
} from "../src/runtime-event-forwarder";

const runtimeGeneration = 7n;

function runtimeFrame(event: AgentDomainEvent): RuntimeEventFrame {
  const payload = JSON.stringify(event, (_key, value: unknown) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Uint8Array) {
      return { base64: Buffer.from(value).toString("base64") };
    }
    return value;
  });
  if (payload === undefined) throw new Error("Expected event to serialize as JSON");
  return {
    eventId: event.eventId,
    kind: event.kind,
    payload: new TextEncoder().encode(payload),
  };
}

function frameWith(kind: string, fields: Record<string, unknown>): RuntimeEventFrame {
  return {
    eventId: "event-test",
    kind,
    payload: new TextEncoder().encode(
      JSON.stringify({
        sessionId: "session-test",
        revision: "1",
        createdAtMs: "100",
        runtimeGeneration: "7",
        ...fields,
      }),
    ),
  };
}

function decodeEvent(event: AgentDomainEvent) {
  const sessionEvent = buildSessionEvent("host-test", runtimeFrame(event));
  expect(sessionEvent.kind).toBe(event.kind);
  return decodeTranscriptEvent(sessionEvent.kind, sessionEvent.payload);
}

describe("buildSessionEvent event kinds", () => {
  test("forwards approval-requested with its content hash", () => {
    const contentHash = Uint8Array.from([0, 1, 254, 255]);
    const event: AgentDomainEvent = {
      kind: "approval-requested",
      eventId: eventId("approval-event"),
      sessionId: sessionId("session-test"),
      revision: 1n,
      createdAtMs: 100n,
      runtimeGeneration,
      approvalRequestId: approvalRequestId("approval-test"),
      expiresAtMs: 500n,
      summary: "Run the requested command?",
      contentHash,
    };

    expect(decodeEvent(event)).toEqual({
      kind: "approval-requested",
      approvalRequestId: "approval-test",
      expiresAtMs: 500n,
      summary: "Run the requested command?",
      contentHash,
    });
  });

  test("forwards ui-requested with a payload", () => {
    const event: AgentDomainEvent = {
      kind: "ui-requested",
      eventId: eventId("ui-event-with-payload"),
      sessionId: sessionId("session-test"),
      revision: 2n,
      createdAtMs: 101n,
      runtimeGeneration,
      uiRequestId: uiRequestId("ui-request-test"),
      uiKind: "select",
      expiresAtMs: 600n,
      payload: { title: "Choose one", options: ["A", "B"] },
      contentHash: Uint8Array.from([2, 3]),
    };

    expect(decodeEvent(event)).toEqual({
      kind: "ui-requested",
      uiRequestId: "ui-request-test",
      uiKind: "select",
      expiresAtMs: 600n,
      payloadJson: '{"title":"Choose one","options":["A","B"]}',
      contentHash: Uint8Array.from([2, 3]),
    });
  });

  test("forwards ui-requested without a payload", () => {
    const event: AgentDomainEvent = {
      kind: "ui-requested",
      eventId: eventId("ui-event-without-payload"),
      sessionId: sessionId("session-test"),
      revision: 3n,
      createdAtMs: 102n,
      runtimeGeneration,
      uiRequestId: uiRequestId("ui-request-empty"),
      uiKind: "confirm",
      expiresAtMs: 700n,
      payload: undefined,
      contentHash: Uint8Array.from([4, 5]),
    };

    expect(decodeEvent(event)).toEqual({
      kind: "ui-requested",
      uiRequestId: "ui-request-empty",
      uiKind: "confirm",
      expiresAtMs: 700n,
      contentHash: Uint8Array.from([4, 5]),
    });
  });

  test("forwards subagent-started and subagent-completed", () => {
    const started: AgentDomainEvent = {
      kind: "subagent-started",
      eventId: eventId("subagent-started-event"),
      sessionId: sessionId("session-test"),
      revision: 4n,
      createdAtMs: 103n,
      runtimeGeneration,
      taskId: "task-test",
      display: { label: "Researcher" },
    };
    const completed: AgentDomainEvent = {
      kind: "subagent-completed",
      eventId: eventId("subagent-completed-event"),
      sessionId: sessionId("session-test"),
      revision: 5n,
      createdAtMs: 104n,
      runtimeGeneration,
      taskId: "task-test",
      display: undefined,
    };

    expect(decodeEvent(started)).toEqual({
      kind: "subagent-started",
      taskId: "task-test",
      displayJson: '{"label":"Researcher"}',
    });
    expect(decodeEvent(completed)).toEqual({ kind: "subagent-completed", taskId: "task-test" });
  });

  test("forwards agent-failed with its reason", () => {
    const event: AgentDomainEvent = {
      kind: "agent-failed",
      eventId: eventId("agent-failed-event"),
      sessionId: sessionId("session-test"),
      runId: runId("run-test"),
      revision: 6n,
      createdAtMs: 105n,
      runtimeGeneration,
      reason: "The tool exited with status 1",
    };

    expect(decodeEvent(event)).toEqual({
      kind: "agent-failed",
      runId: "run-test",
      reason: "The tool exited with status 1",
    });
  });
});

describe("buildSessionEvent malformed event kinds", () => {
  test.each([
    {
      name: "bad uiKind",
      kind: "ui-requested",
      fields: {
        uiRequestId: "ui-test",
        uiKind: "unsupported",
        expiresAtMs: "500",
        contentHash: { base64: "AQ==" },
      },
    },
    {
      name: "summary that is not a string",
      kind: "approval-requested",
      fields: {
        approvalRequestId: "approval-test",
        expiresAtMs: "500",
        summary: 42,
        contentHash: { base64: "AQ==" },
      },
    },
    {
      name: "contentHash array",
      kind: "approval-requested",
      fields: {
        approvalRequestId: "approval-test",
        expiresAtMs: "500",
        summary: "Approve?",
        contentHash: [1, 2],
      },
    },
    {
      name: "contentHash.base64 that is not a string",
      kind: "approval-requested",
      fields: {
        approvalRequestId: "approval-test",
        expiresAtMs: "500",
        summary: "Approve?",
        contentHash: { base64: 12 },
      },
    },
    { name: "items that are not an array", kind: "todo-updated", fields: { items: "todo" } },
    { name: "item that is not an object", kind: "todo-updated", fields: { items: [null] } },
    {
      name: "invalid todo status",
      kind: "todo-updated",
      fields: { items: [{ id: "todo-1", text: "Do the work", status: "blocked" }] },
    },
    {
      name: "empty reason",
      kind: "agent-failed",
      fields: { runId: "run-test", reason: "" },
    },
  ])("rejects $name", ({ kind, fields }) => {
    expect(() => buildSessionEvent("host-test", frameWith(kind, fields))).toThrow(
      RuntimeEventForwarderError,
    );
  });
});

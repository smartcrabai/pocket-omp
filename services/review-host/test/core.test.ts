import { expect, test } from "bun:test";
import { ReviewHost } from "../src/core";

test("review Host exposes deterministic approval, file, and encrypted attachment flow only to review account", () => {
  const host = new ReviewHost("review-account", () => "session-1");
  const started = host.start("review-account");
  expect(started.events.map((event) => event.kind)).toEqual(["message", "tool", "approval"]);
  const completed = host.approve("review-account", started.sessionId, true);
  expect(completed.map((event) => event.kind)).toEqual([
    "message",
    "tool",
    "approval",
    "approval",
    "file",
    "attachment",
    "complete",
  ]);
  expect(completed.find((event) => event.kind === "attachment")?.payload.encrypted).toBeTrue();
  expect(host.approve("review-account", started.sessionId, true)).toHaveLength(7);
  expect(() => host.start("production-account")).toThrow("account is denied");
});

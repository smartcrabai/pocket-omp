import { encodeSecurePayload } from "@pocket-omp/session-protocol";
import { expect, test } from "bun:test";
import {
  createStubCommandDispatcher,
  type InboundDispatchEvent,
} from "../src/stub-command-dispatcher";

test("dispatch records the decoded SecurePayload kind without throwing", async () => {
  const events: InboundDispatchEvent[] = [];
  const dispatcher = createStubCommandDispatcher({ onInbound: (event) => events.push(event) });
  const plaintext = encodeSecurePayload({
    capabilitySet: "",
    body: {
      kind: "device-hello",
      value: { deviceId: "device-1", deviceKind: "mobile", capabilities: [] },
    },
  });
  await dispatcher.dispatch("message-1", plaintext);
  expect(events).toEqual([{ messageId: "message-1", kind: "device-hello" }]);
});

test("dispatch swallows a malformed plaintext instead of throwing, so a poison message cannot wedge the inbound queue", async () => {
  const events: InboundDispatchEvent[] = [];
  const dispatcher = createStubCommandDispatcher({ onInbound: (event) => events.push(event) });
  await dispatcher.dispatch("message-1", new Uint8Array([1, 2, 3, 4]));
  expect(events).toHaveLength(1);
  expect(events[0]?.messageId).toBe("message-1");
  expect(events[0]?.kind).toContain("decode-error:");
});

test("dispatch works with no onInbound callback supplied", async () => {
  const dispatcher = createStubCommandDispatcher();
  const plaintext = encodeSecurePayload({
    capabilitySet: "",
    body: { kind: "error", value: { code: "X", message: "y", retryable: false } },
  });
  await expect(dispatcher.dispatch("message-1", plaintext)).resolves.toBeUndefined();
});

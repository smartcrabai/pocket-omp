// Covers reconnectDelay() and RelayClientError, the two src/index.ts
// exports that don't go through WorkerRelayClient (see http.test.ts and
// subscribe.test.ts for those).

import { expect, test } from "bun:test";
import { RelayClientError, reconnectDelay } from "../src/index";

test("reconnectDelay() rejects a negative or non-integer attempt", () => {
  expect(() => reconnectDelay(-1, { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 })).toThrow(
    RelayClientError,
  );
  expect(() =>
    reconnectDelay(1.5, { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0 }),
  ).toThrow(RelayClientError);
});

test("reconnectDelay() rejects an invalid policy", () => {
  const attempt = 0;
  expect(() =>
    reconnectDelay(attempt, { baseDelayMs: 0, maxDelayMs: 1000, random: () => 0 }),
  ).toThrow(RelayClientError);
  expect(() =>
    reconnectDelay(attempt, { baseDelayMs: -100, maxDelayMs: 1000, random: () => 0 }),
  ).toThrow(RelayClientError);
  expect(() =>
    reconnectDelay(attempt, { baseDelayMs: 1000, maxDelayMs: 100, random: () => 0 }),
  ).toThrow(RelayClientError);
  expect(() =>
    reconnectDelay(attempt, { baseDelayMs: 100, maxDelayMs: 1000, random: () => Number.NaN }),
  ).toThrow(RelayClientError);
  expect(() =>
    reconnectDelay(attempt, {
      baseDelayMs: 100,
      maxDelayMs: 1000,
      random: () => Number.POSITIVE_INFINITY,
    }),
  ).toThrow(RelayClientError);
});

test("reconnectDelay() computes an exponential delay scaled by the random jitter", () => {
  expect(reconnectDelay(3, { baseDelayMs: 1000, maxDelayMs: 60_000, random: () => 0.25 })).toBe(
    5000,
  );
});

test("reconnectDelay() clamps the exponential growth to maxDelayMs", () => {
  expect(reconnectDelay(20, { baseDelayMs: 1000, maxDelayMs: 5000, random: () => 1 })).toBe(5000);
});

test("reconnectDelay() clamps a jitter value outside [0, 1]", () => {
  expect(reconnectDelay(0, { baseDelayMs: 100, maxDelayMs: 1000, random: () => 2 })).toBe(100);
  expect(reconnectDelay(0, { baseDelayMs: 100, maxDelayMs: 1000, random: () => -5 })).toBe(50);
});

test("RelayClientError carries its code and sets the Error name", () => {
  const error = new RelayClientError("SOME_CODE", "boom");
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("RelayClientError");
  expect(error.code).toBe("SOME_CODE");
  expect(error.message).toBe("boom");
});

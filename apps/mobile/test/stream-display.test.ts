import { describe, expect, test } from "bun:test";
import type { StreamState } from "@pocket-omp/mobile-core";
import { cursorOf, describeStreamState } from "../src/stream-display";

describe("describeStreamState", () => {
  test("maps every StreamState kind to a distinct, non-empty display", () => {
    const states: readonly StreamState[] = [
      { kind: "idle" },
      { kind: "obtaining-ticket" },
      { kind: "connecting", generation: "g1" },
      { kind: "catching-up", generation: "g1", cursor: 1n },
      { kind: "live", generation: "g1", cursor: 2n },
      { kind: "backing-off", attempt: 3, retryAtMs: 1_000n },
      { kind: "reauthenticating" },
      { kind: "suspended", cursor: 4n },
      { kind: "entitlement-required" },
      { kind: "fatal", code: "BOOM" },
    ];
    for (const state of states) {
      const display = describeStreamState(state);
      expect(display.label.length).toBeGreaterThan(0);
      expect(display.detail.length).toBeGreaterThan(0);
    }
  });

  test("live is tagged with the live tone and never shows a subscription CTA", () => {
    const display = describeStreamState({ kind: "live", generation: "g1", cursor: 2n });
    expect(display.tone).toBe("live");
    expect(display.showSubscriptionCta).toBeFalse();
  });

  test("entitlement-required surfaces the subscription CTA", () => {
    const display = describeStreamState({ kind: "entitlement-required" });
    expect(display.tone).toBe("entitlement-required");
    expect(display.showSubscriptionCta).toBeTrue();
  });

  test("backing-off includes the attempt count in its detail text", () => {
    const display = describeStreamState({ kind: "backing-off", attempt: 5, retryAtMs: 0n });
    expect(display.detail).toContain("5");
  });

  test("fatal includes the error code in its detail text", () => {
    const display = describeStreamState({ kind: "fatal", code: "RELAY_UNREACHABLE" });
    expect(display.tone).toBe("fatal");
    expect(display.detail).toContain("RELAY_UNREACHABLE");
  });

  test("a runFailure overrides the state-derived display with a fatal tone", () => {
    const display = describeStreamState({ kind: "live", generation: "g1", cursor: 2n }, "boom");
    expect(display.tone).toBe("fatal");
    expect(display.detail).toBe("boom");
    expect(display.showSubscriptionCta).toBeFalse();
  });
});

describe("cursorOf", () => {
  test("reads the cursor from states that carry one", () => {
    expect(cursorOf({ kind: "catching-up", generation: "g1", cursor: 7n })).toBe(7n);
    expect(cursorOf({ kind: "live", generation: "g1", cursor: 8n })).toBe(8n);
    expect(cursorOf({ kind: "suspended", cursor: 9n })).toBe(9n);
  });

  test("falls back to 0n for states with no cursor of their own", () => {
    expect(cursorOf({ kind: "idle" })).toBe(0n);
    expect(cursorOf({ kind: "obtaining-ticket" })).toBe(0n);
    expect(cursorOf({ kind: "connecting", generation: "g1" })).toBe(0n);
    expect(cursorOf({ kind: "backing-off", attempt: 1, retryAtMs: 0n })).toBe(0n);
    expect(cursorOf({ kind: "reauthenticating" })).toBe(0n);
    expect(cursorOf({ kind: "entitlement-required" })).toBe(0n);
    expect(cursorOf({ kind: "fatal", code: "X" })).toBe(0n);
  });
});

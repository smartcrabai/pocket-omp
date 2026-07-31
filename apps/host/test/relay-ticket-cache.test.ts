import { expect, test } from "bun:test";
import { RelayTicketCache, RelayTicketCacheError } from "../src/relay-ticket-cache";

function issuer(calls: number[] = []): {
  readonly issue: () => Promise<{ ticket: string; relayOrigin: string; expiresAtMs: bigint }>;
  readonly calls: readonly number[];
} {
  let sequence = 0;
  return {
    calls,
    issue: async () => {
      sequence += 1;
      calls.push(sequence);
      return {
        ticket: `ticket-${sequence}`,
        relayOrigin: "https://relay.example.test",
        expiresAtMs: 1_000_000n + BigInt(sequence) * 600_000n,
      };
    },
  };
}

test("reuses a cached ticket while inside the refresh margin", async () => {
  const { issue, calls } = issuer();
  let now = 0n;
  const cache = new RelayTicketCache({ issue, now: () => now, refreshMarginMs: 60_000n });

  now = 100_000n; // first ticket expires at 1_600_000n; well inside the margin
  expect(await cache.ticket()).toBe("ticket-1");
  expect(await cache.ticket()).toBe("ticket-1");
  expect(await cache.relayOrigin()).toBe("https://relay.example.test");
  expect(calls).toEqual([1]);
});

test("refetches once the cached ticket is within the refresh margin of expiry", async () => {
  const { issue, calls } = issuer();
  let now = 0n;
  const cache = new RelayTicketCache({ issue, now: () => now, refreshMarginMs: 60_000n });

  now = 100_000n;
  expect(await cache.ticket()).toBe("ticket-1"); // expiresAtMs = 1_600_000n
  now = 1_600_000n - 60_000n; // exactly at the margin boundary: still stale
  expect(await cache.ticket()).toBe("ticket-2");
  expect(calls).toEqual([1, 2]);
});

test("does not refetch just outside the refresh margin boundary", async () => {
  const { issue, calls } = issuer();
  let now = 0n;
  const cache = new RelayTicketCache({ issue, now: () => now, refreshMarginMs: 60_000n });

  now = 100_000n;
  await cache.ticket(); // expiresAtMs = 1_600_000n
  now = 1_600_000n - 60_000n - 1n; // one ms before the margin boundary
  expect(await cache.ticket()).toBe("ticket-1");
  expect(calls).toEqual([1]);
});

test("invalidate() forces the next call to fetch a fresh ticket even inside the margin", async () => {
  const { issue, calls } = issuer();
  const cache = new RelayTicketCache({ issue, now: () => 0n, refreshMarginMs: 60_000n });
  expect(await cache.ticket()).toBe("ticket-1");
  cache.invalidate();
  expect(await cache.ticket()).toBe("ticket-2");
  expect(calls).toEqual([1, 2]);
});

test("concurrent callers during a refresh share a single in-flight issue() call", async () => {
  const calls: number[] = [];
  let sequence = 0;
  let resolveIssue: (() => void) | undefined;
  const cache = new RelayTicketCache({
    now: () => 0n,
    issue: () =>
      new Promise((resolvePromise) => {
        sequence += 1;
        calls.push(sequence);
        resolveIssue = () =>
          resolvePromise({
            ticket: `ticket-${sequence}`,
            relayOrigin: "https://relay.example.test",
            expiresAtMs: 600_000n,
          });
      }),
  });

  const first = cache.ticket();
  const second = cache.ticket();
  resolveIssue?.();
  expect(await first).toBe("ticket-1");
  expect(await second).toBe("ticket-1");
  expect(calls).toEqual([1]);
});

test("rejects a negative refresh margin", () => {
  expect(
    () =>
      new RelayTicketCache({
        issue: async () => ({
          ticket: "t",
          relayOrigin: "https://relay.example.test",
          expiresAtMs: 0n,
        }),
        refreshMarginMs: -1n,
      }),
  ).toThrow(RelayTicketCacheError);
});

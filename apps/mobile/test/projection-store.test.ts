import { describe, expect, test } from "bun:test";
import { applyProjectionEvent, emptyProjection } from "@pocket-omp/mobile-core";
import {
  decodeCursor,
  encodeCursor,
  routeProjectionCursorKey,
  SecureProjectionStore,
  type SecureStoreLike,
} from "../src/projection-store";

function fakeSecureStore(): SecureStoreLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItemAsync: (key) => Promise.resolve(values.get(key) ?? null),
    setItemAsync: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("cursor encoding", () => {
  test("round-trips a bigint through base-10 text without precision loss", () => {
    const cursor = 9_007_199_254_740_993n;
    expect(decodeCursor(encodeCursor(cursor))).toBe(cursor);
  });

  test("rejects corrupt stored values", () => {
    expect(() => decodeCursor("not-a-number")).toThrow();
    expect(() => decodeCursor("-1")).toThrow();
  });
});

describe("SecureProjectionStore", () => {
  test("load() returns cursor 0 and an empty projection before anything is committed", async () => {
    const store = new SecureProjectionStore("route-1", fakeSecureStore());
    const loaded = await store.load();
    expect(loaded.cursor).toBe(0n);
    expect(loaded.projection).toEqual(emptyProjection());
  });

  test("commit() persists the cursor under the route-scoped key and load() restores it", async () => {
    const secureStore = fakeSecureStore();
    const store = new SecureProjectionStore("route-1", secureStore);
    const applied = applyProjectionEvent(emptyProjection(), {
      eventId: "event-1",
      sessionId: "session-1",
      revision: 1n,
      kind: "message",
      payload: {},
    });
    await store.commit(5n, applied.state);
    expect(secureStore.values.get(routeProjectionCursorKey("route-1"))).toBe("5");
    const loaded = await store.load();
    expect(loaded.cursor).toBe(5n);
    // The in-memory projection survives on the *same* store instance...
    expect(loaded.projection).toEqual(applied.state);
  });

  test("a fresh store instance restores the cursor but not the in-memory projection body", async () => {
    // This is the documented cursor-only persistence trade-off: a cold
    // start (new instance, e.g. after an app restart) only recovers the
    // cursor, not the projection body accumulated before it.
    const secureStore = fakeSecureStore();
    const first = new SecureProjectionStore("route-1", secureStore);
    const applied = applyProjectionEvent(emptyProjection(), {
      eventId: "event-1",
      sessionId: "session-1",
      revision: 1n,
      kind: "message",
      payload: {},
    });
    await first.commit(5n, applied.state);

    const second = new SecureProjectionStore("route-1", secureStore);
    const loaded = await second.load();
    expect(loaded.cursor).toBe(5n);
    expect(loaded.projection).toEqual(emptyProjection());
  });

  test("cursor persistence is scoped per route", async () => {
    const secureStore = fakeSecureStore();
    const routeA = new SecureProjectionStore("route-a", secureStore);
    const routeB = new SecureProjectionStore("route-b", secureStore);
    await routeA.commit(10n, emptyProjection());
    const loadedB = await routeB.load();
    expect(loadedB.cursor).toBe(0n);
  });

  test("current reflects the most recently committed projection", async () => {
    const store = new SecureProjectionStore("route-1", fakeSecureStore());
    expect(store.current).toEqual(emptyProjection());
    const applied = applyProjectionEvent(emptyProjection(), {
      eventId: "event-1",
      sessionId: "session-1",
      revision: 1n,
      kind: "message",
      payload: {},
    });
    await store.commit(1n, applied.state);
    expect(store.current).toEqual(applied.state);
  });

  test("subscribe() notifies listeners after every commit()", async () => {
    const store = new SecureProjectionStore("route-1", fakeSecureStore());
    const notifications: number[] = [];
    const unsubscribe = store.subscribe(() => {
      notifications.push(notifications.length);
    });
    await store.commit(1n, emptyProjection());
    await store.commit(2n, emptyProjection());
    expect(notifications).toEqual([0, 1]);
    unsubscribe();
    await store.commit(3n, emptyProjection());
    expect(notifications).toEqual([0, 1]);
  });

  test("subscribe() supports multiple independent listeners", async () => {
    const store = new SecureProjectionStore("route-1", fakeSecureStore());
    let firstCount = 0;
    let secondCount = 0;
    store.subscribe(() => {
      firstCount += 1;
    });
    store.subscribe(() => {
      secondCount += 1;
    });
    await store.commit(1n, emptyProjection());
    expect(firstCount).toBe(1);
    expect(secondCount).toBe(1);
  });
});

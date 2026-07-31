// MobileProjectionStore implementation (packages/mobile-core).
//
// Persistence strategy: only the relay delivery cursor is persisted; the
// projection body is kept in memory only. apps/mobile has no dependency
// suited to storing a growing, unbounded projection -- expo-secure-store is
// the only persistence primitive available (per the platform keychain/
// keystore it wraps, it is not meant for large payloads, and is capacity
// constrained on Android in particular) and no new npm dependency may be
// added for this task. Persisting the cursor alone is sufficient for
// ADR-014's normal-recovery path ("replay deltas from the acknowledged
// cursor"): on a cold app start, `load()` returns the last acknowledged
// cursor with a *fresh* empty projection, and MobileStreamManager resumes
// delivery from that cursor, rebuilding a live projection from that point
// forward. What is deliberately NOT implemented here -- and left as future
// work -- is reconstructing the projection body that existed *before* that
// cursor (e.g. by decrypting and replaying a relay snapshot on cold start).
// Until that lands, a cold start after a long delta history will start the
// visible projection empty rather than fully backfilled; this only affects
// the in-memory reducer, not correctness of the cursor/ack protocol itself.
import {
  emptyProjection,
  type MobileProjectionStore,
  type ProjectionState,
} from "@pocket-omp/mobile-core";

// A narrowed subset of expo-secure-store's surface, defined locally (rather
// than importing expo-secure-store's own types) so this module never
// imports a native module and stays loadable under `bun test`; the real
// module satisfies this interface structurally wherever
// SecureProjectionStore is constructed for the running app.
export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
}

export function routeProjectionCursorKey(routeId: string): string {
  return `route.${routeId}.projection-cursor`;
}

// SecureStore values are strings; cursors are bigints (relay server
// sequences), which are neither JSON-serializable nor safe to round-trip
// through Number(). Encode/decode as base-10 text instead.
export function encodeCursor(cursor: bigint): string {
  return cursor.toString(10);
}

export function decodeCursor(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) throw new Error("Stored projection cursor is corrupt");
  return BigInt(value);
}

export class SecureProjectionStore implements MobileProjectionStore {
  #cached: ProjectionState = emptyProjection();
  readonly #listeners = new Set<() => void>();

  public constructor(
    private readonly routeId: string,
    private readonly secureStore: SecureStoreLike,
  ) {}

  public async load(): Promise<{ readonly cursor: bigint; readonly projection: ProjectionState }> {
    const stored = await this.secureStore.getItemAsync(routeProjectionCursorKey(this.routeId));
    const cursor = stored === null ? 0n : decodeCursor(stored);
    return { cursor, projection: this.#cached };
  }

  public async commit(cursor: bigint, projection: ProjectionState): Promise<void> {
    await this.secureStore.setItemAsync(
      routeProjectionCursorKey(this.routeId),
      encodeCursor(cursor),
    );
    this.#cached = projection;
    this.#notify();
  }

  // Synchronous read of the in-memory projection, exactly as it stood after
  // the most recent commit() call. Added for the UI layer (see
  // apps/mobile/src/stream.tsx), which reads this via React's
  // useSyncExternalStore alongside subscribe() below -- that hook requires a
  // synchronous getSnapshot, which the MobileProjectionStore interface
  // (packages/mobile-core) has no reason to provide since
  // MobileStreamManager only ever calls load()/commit().
  public get current(): ProjectionState {
    return this.#cached;
  }

  // Registers a listener invoked (with no arguments, matching React's
  // useSyncExternalStore subscribe contract) after every commit(). This is
  // purely a Mobile UI addition layered on top of the MobileProjectionStore
  // interface this class implements -- packages/mobile-core's
  // MobileStreamManager has no notion of "subscribe" and never calls it.
  // Returns an unsubscribe function.
  public subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

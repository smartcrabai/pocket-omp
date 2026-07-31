// Composition root wiring MobileStreamManager (packages/mobile-core) into
// React, following the same provider/hook shape as auth.tsx. Constructs the
// real MobileWebSocketRelayPort / SecureStoreEnvelopeCrypto /
// SecureProjectionStore for whichever Host route this device has paired
// (see resolveActiveRoute below), starts MobileStreamManager.run() once
// signed in with a paired route, and stops/resumes it as the app leaves and
// re-enters the foreground.
//
// Scope note: a device can pair with more than one Host (see devices.tsx's
// list of "pocket-omp.paired-routes"), but MobileStreamManager subscribes to
// exactly one Relay route at a time. Wiring multiple concurrent
// subscriptions is out of scope for this task; this provider subscribes to
// the first paired route only, same as app/pair.tsx's own single-Host
// pairing flow implies today.
import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import {
  emptyProjection,
  MobileStreamManager,
  type ProjectionState,
  type StreamState,
} from "@pocket-omp/mobile-core";
import { useAuth } from "./auth";
import { loadDeviceCredential } from "./credentials";
import { SecureStoreEnvelopeCrypto } from "./relay-crypto";
import {
  MobileWebSocketRelayPort,
  type RelayFetch,
  type RelaySocket,
  type RelaySocketEvent,
} from "./relay-port";
import { SecureProjectionStore } from "./projection-store";
import { cursorOf } from "./stream-display";

// Bridges the global `fetch` (typed via the "DOM" lib, see
// RuntimeRelaySocket's doc comment below) to relay-port.ts's RelayFetch.
// Only the request body actually needs bridging: this TS/lib version's
// two-type-parameter Uint8Array (Uint8Array<ArrayBufferLike>) doesn't
// structurally match BodyInit's BufferSource member, even though a Uint8Array
// is exactly what fetch's real body parameter accepts at runtime.
const relayFetch: RelayFetch = (input, init) =>
  fetch(input, {
    method: init.method,
    headers: init.headers,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see this const's doc comment: a plain string/Uint8Array body is exactly what fetch accepts at runtime.
    body: init.body as BodyInit,
  });

// Adapts the platform's global WebSocket -- typed via the "DOM" lib
// apps/mobile's tsconfig pulls in for fetch/WebSocket/atob/crypto (see
// expo/tsconfig.base.json) and satisfied at runtime by React Native's own
// WebSocket implementation -- to RelaySocket (relay-port.ts). A thin wrapper
// is needed (rather than passing the global class straight through) because
// RelaySocket's addEventListener is deliberately narrower than
// EventTarget's; the casts below only bridge type shapes that are already
// compatible at runtime (a WebSocket "message" event really does carry a
// `.data` field, matching RelaySocketEvent), never actually-unknown data.
class RuntimeRelaySocket implements RelaySocket {
  readonly #socket: WebSocket;

  public constructor(url: string, protocols: readonly string[]) {
    this.#socket = new WebSocket(url, [...protocols]);
  }

  public get binaryType(): string {
    return this.#socket.binaryType;
  }

  public set binaryType(value: string) {
    if (value === "blob" || value === "arraybuffer") {
      this.#socket.binaryType = value;
      return;
    }
    throw new Error(`Unsupported WebSocket binaryType ${value}`);
  }

  public get readyState(): number {
    return this.#socket.readyState;
  }

  public send(data: Uint8Array): void {
    this.#socket.send(data);
  }

  public close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }

  public addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (() => void) | ((event: RelaySocketEvent) => void),
    options?: { readonly once?: boolean },
  ): void {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see this class's doc comment: a "message" event really does carry `.data`, matching RelaySocketEvent.
    this.#socket.addEventListener(type, listener as EventListener, options);
  }

  public removeEventListener(type: "open" | "close" | "error", listener: () => void): void {
    this.#socket.removeEventListener(type, listener);
  }
}

interface StreamContextValue {
  // False before a paired Host route (and its device credential) has been
  // resolved -- including "signed out" and "never paired" -- so the UI can
  // tell "haven't tried to connect yet" apart from every StreamState, which
  // only exists once a subscription attempt has actually started.
  readonly hasRoute: boolean;
  readonly state: StreamState;
  readonly projection: ProjectionState;
  // Set when the most recent MobileStreamManager.run() call rejected. See
  // stream-display.ts's describeStreamState doc comment for why this is
  // threaded separately from StreamState.
  readonly runFailure: string | undefined;
  // Re-attempts the subscription immediately, without waiting for an
  // AppState background/foreground cycle. A no-op while a route hasn't
  // resolved yet or the manager is already in a non-resumable state.
  readonly retry: () => void;
}

const IDLE_STATE: StreamState = { kind: "idle" };
const EMPTY_PROJECTION: ProjectionState = emptyProjection();
const NO_OP = (): void => undefined;

const StreamContext = createContext<StreamContextValue | undefined>(undefined);

interface ActiveRoute {
  readonly routeId: string;
  readonly deviceId: string;
  readonly credential: string;
}

export function StreamProvider({ children }: PropsWithChildren): ReactElement {
  const auth = useAuth();
  const [route, setRoute] = useState<ActiveRoute | undefined>(undefined);

  // Resolves which paired route (if any) to subscribe to whenever sign-in
  // state changes. Only runs once per accessToken transition, not on every
  // render.
  useEffect(() => {
    if (auth.accessToken === undefined) {
      setRoute(undefined);
      return undefined;
    }
    let active = true;
    void resolveActiveRoute()
      .then((resolved) => {
        if (active) setRoute(resolved);
        return undefined;
      })
      .catch(() => {
        if (active) setRoute(undefined);
      });
    return () => {
      active = false;
    };
  }, [auth.accessToken]);

  const [store, setStore] = useState<SecureProjectionStore | undefined>(undefined);
  const [state, setState] = useState<StreamState>(IDLE_STATE);
  const [runFailure, setRunFailure] = useState<string | undefined>(undefined);
  const startRef = useRef<() => void>(NO_OP);

  useEffect(() => {
    if (auth.accessToken === undefined || route === undefined) {
      setStore(undefined);
      setState(IDLE_STATE);
      setRunFailure(undefined);
      startRef.current = NO_OP;
      return undefined;
    }
    const controlUrl = process.env.EXPO_PUBLIC_CONTROL_URL;
    if (controlUrl === undefined) {
      setStore(undefined);
      setState(IDLE_STATE);
      setRunFailure("EXPO_PUBLIC_CONTROL_URL is not configured");
      startRef.current = NO_OP;
      return undefined;
    }

    let cancelled = false;
    const nextStore = new SecureProjectionStore(route.routeId, SecureStore);
    const crypto = new SecureStoreEnvelopeCrypto(SecureStore);
    const port = new MobileWebSocketRelayPort({
      fetch: relayFetch,
      webSocket: RuntimeRelaySocket,
      now: () => Date.now(),
      controlUrl,
      credential: { deviceId: route.deviceId, credential: route.credential },
    });
    const manager = new MobileStreamManager(port, nextStore, crypto, setState);
    setStore(nextStore);
    setState(manager.state);

    let controller = new AbortController();
    const start = (): void => {
      if (cancelled) return;
      if (
        manager.state.kind !== "idle" &&
        manager.state.kind !== "suspended" &&
        manager.state.kind !== "backing-off"
      )
        return;
      setRunFailure(undefined);
      controller = new AbortController();
      const { signal } = controller;
      void manager.run(signal).catch((error: unknown) => {
        if (cancelled || signal.aborted) return;
        // run() rejected without moving `state` anywhere distinguishable
        // (see stream-display.ts's doc comment); force it back to a
        // resumable state so a later retry()/foreground doesn't hit
        // MobileInvariantError from an invalid transition.
        manager.suspend(cursorOf(manager.state));
        setRunFailure(error instanceof Error ? error.message : "Relay stream failed");
      });
    };
    startRef.current = start;
    start();

    const subscription = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (cancelled) return;
      if (next === "active") {
        start();
      } else {
        controller.abort();
        manager.suspend(cursorOf(manager.state));
      }
    });

    return () => {
      cancelled = true;
      startRef.current = NO_OP;
      subscription.remove();
      controller.abort();
    };
  }, [auth.accessToken, route]);

  const subscribe = useCallback(
    (listener: () => void) => (store === undefined ? NO_OP : store.subscribe(listener)),
    [store],
  );
  const getSnapshot = useCallback(() => store?.current ?? EMPTY_PROJECTION, [store]);
  const projection = useSyncExternalStore(subscribe, getSnapshot);

  const retry = useCallback(() => {
    startRef.current();
  }, []);

  const value = useMemo<StreamContextValue>(
    () => ({ hasRoute: route !== undefined, state, projection, runFailure, retry }),
    [route, state, projection, runFailure, retry],
  );

  return <StreamContext.Provider value={value}>{children}</StreamContext.Provider>;
}

export function useStream(): StreamContextValue {
  const context = useContext(StreamContext);
  if (context === undefined) throw new Error("StreamProvider is missing");
  return context;
}

async function resolveActiveRoute(): Promise<ActiveRoute | undefined> {
  const raw = await SecureStore.getItemAsync("pocket-omp.paired-routes");
  if (raw === null) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const routeId = parsed[0];
  if (typeof routeId !== "string") return undefined;
  const credential = await loadDeviceCredential(routeId);
  if (credential === undefined) return undefined;
  return { routeId, deviceId: credential.deviceId, credential: credential.deviceCredential };
}

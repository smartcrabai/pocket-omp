import { describe, expect, test } from "bun:test";

import { ControlClient } from "../src/control-client";

const origin = new URL("https://control.example.test");

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

const watchAwaitingClaimFetcher: typeof fetch = async () =>
  Response.json({
    pairing_id: "pairing-1",
    state: "awaiting-claim",
    host_name: "My Host",
    host_confirmed: false,
    mobile_confirmed: false,
    expires_at_ms: 1,
  });

const abortAwareFetcher: typeof fetch = async (_input, init) => {
  if (init?.signal?.aborted === true) {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  return Response.json({});
};

describe("ControlClient", () => {
  test("beginPairing sends the documented request and parses a valid response", async () => {
    const requests: { method: string; pathname: string; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(requestUrl(input));
      requests.push({
        method: init?.method ?? "GET",
        pathname: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({
        pairing_id: "pairing-1",
        challenge: "11".repeat(32),
        watch_secret: "secret-xyz",
        expires_at_ms: 1_700_000_000_000,
        service_identifier: "pocket-omp",
      });
    };
    const client = new ControlClient({ origin, fetch: fetcher });
    const result = await client.beginPairing({
      hostName: "My Host",
      hostPublicKey: new Uint8Array(32).fill(7),
    });
    expect(requests).toEqual([
      {
        method: "POST",
        pathname: "/v1/pairings",
        body: { host_name: "My Host", host_public_key: "07".repeat(32) },
      },
    ]);
    expect(result).toEqual({
      pairingId: "pairing-1",
      challenge: new Uint8Array(32).fill(0x11),
      watchSecret: "secret-xyz",
      expiresAtMs: 1_700_000_000_000n,
      serviceIdentifier: "pocket-omp",
    });
  });

  test("rejects a non-2xx response", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await expect(
      client.beginPairing({ hostName: "Host", hostPublicKey: new Uint8Array(32) }),
    ).rejects.toMatchObject({ code: "HTTP_STATUS" });
  });

  test("rejects a response missing a required field", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () =>
        Response.json({
          pairing_id: "pairing-1",
          challenge: "11".repeat(32),
          // watch_secret intentionally missing
          expires_at_ms: 1,
          service_identifier: "pocket-omp",
        }),
    });
    await expect(
      client.beginPairing({ hostName: "Host", hostPublicKey: new Uint8Array(32) }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("rejects a malformed hex field", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () =>
        Response.json({
          pairing_id: "pairing-1",
          challenge: "not-hex",
          watch_secret: "s",
          expires_at_ms: 1,
          service_identifier: "pocket-omp",
        }),
    });
    await expect(
      client.beginPairing({ hostName: "Host", hostPublicKey: new Uint8Array(32) }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("rejects a non-object JSON response", async () => {
    const client = new ControlClient({ origin, fetch: async () => Response.json([1, 2, 3]) });
    await expect(
      client.beginPairing({ hostName: "Host", hostPublicKey: new Uint8Array(32) }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("wraps network failures", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      client.beginPairing({ hostName: "Host", hostPublicKey: new Uint8Array(32) }),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });

  test("watchPairing sends watch_secret as a query parameter and parses optional fields", async () => {
    let capturedUrl: URL | undefined;
    const fetcher: typeof fetch = async (input) => {
      capturedUrl = new URL(requestUrl(input));
      return Response.json({
        pairing_id: "pairing-1",
        state: "awaiting-confirmations",
        host_name: "My Host",
        mobile_public_key: "22".repeat(32),
        route_id: "route-1",
        host_confirmed: false,
        mobile_confirmed: false,
        expires_at_ms: 1,
      });
    };
    const client = new ControlClient({ origin, fetch: fetcher });
    const result = await client.watchPairing("pairing-1", "watch-secret");
    expect(capturedUrl?.pathname).toBe("/v1/pairings/pairing-1/watch");
    expect(capturedUrl?.searchParams.get("watch_secret")).toBe("watch-secret");
    expect(result.mobilePublicKey).toEqual(new Uint8Array(32).fill(0x22));
    expect(result.routeId).toBe("route-1");
  });

  test("watchPairing omits optional fields before the mobile claims", async () => {
    const client = new ControlClient({ origin, fetch: watchAwaitingClaimFetcher });
    const result = await client.watchPairing("pairing-1", "watch-secret");
    expect(result.mobilePublicKey).toBeUndefined();
    expect(result.routeId).toBeUndefined();
  });

  test("completePairingAsHost sends actor=host with the watch secret", async () => {
    const requests: { pathname: string; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({
        pathname: new URL(requestUrl(input)).pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({
        host_id: "host-1",
        route_id: "route-1",
        device_credential: "poc_dev_abc",
        state: "awaiting-confirmations",
        recipient_device_id: "mobile-1",
      });
    };
    const client = new ControlClient({ origin, fetch: fetcher });
    const result = await client.completePairingAsHost("pairing-1", "watch-secret");
    expect(requests).toEqual([
      {
        pathname: "/v1/pairings/pairing-1/complete",
        body: { actor: "host", watch_secret: "watch-secret" },
      },
    ]);
    expect(result).toEqual({
      hostId: "host-1",
      routeId: "route-1",
      deviceCredential: "poc_dev_abc",
      state: "awaiting-confirmations",
      recipientDeviceId: "mobile-1",
    });
  });

  test("completePairingAsHost tolerates a response missing recipient_device_id (control-api that predates the field)", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () =>
        Response.json({
          host_id: "host-1",
          route_id: "route-1",
          device_credential: "poc_dev_abc",
          state: "awaiting-confirmations",
          // recipient_device_id intentionally missing -- pairing already
          // succeeded server-side, so this must not fail the whole call
          // (see apps/host/src/pairing.ts's backfillRecipientDeviceId).
        }),
    });
    const result = await client.completePairingAsHost("pairing-1", "watch-secret");
    expect(result).toEqual({
      hostId: "host-1",
      routeId: "route-1",
      deviceCredential: "poc_dev_abc",
      state: "awaiting-confirmations",
    });
    expect(result.recipientDeviceId).toBeUndefined();
  });

  test("rejects an aborted request distinctly from a generic network failure", async () => {
    const client = new ControlClient({ origin, fetch: abortAwareFetcher });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.beginPairing(
        { hostName: "Host", hostPublicKey: new Uint8Array(32) },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("issueRelayTicket authenticates with the device credential and sends the documented request body", async () => {
    const requests: { pathname: string; authorization: string | null; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        pathname: new URL(requestUrl(input)).pathname,
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({
        ticket: "eyJhbGciOiJFZERTQSJ9.fake.signature",
        relay_origin: "https://relay.example.test",
        expires_at_ms: 1_700_000_600_000,
        route_epoch: "3",
      });
    };
    const client = new ControlClient({ origin, fetch: fetcher });
    const result = await client.issueRelayTicket({
      deviceId: "host-1",
      deviceCredential: "poc_dev_secret",
      routeIds: ["route-1"],
    });
    expect(requests).toEqual([
      {
        pathname: "/v1/relay-tickets",
        authorization: "Bearer poc_dev_secret",
        body: { device_id: "host-1", route_ids: ["route-1"] },
      },
    ]);
    expect(result).toEqual({
      ticket: "eyJhbGciOiJFZERTQSJ9.fake.signature",
      relayOrigin: "https://relay.example.test",
      expiresAtMs: 1_700_000_600_000n,
      routeEpoch: 3n,
    });
  });

  test("issueRelayTicket defaults route_ids to an empty array when none are given", async () => {
    let body: unknown;
    const fetcher: typeof fetch = async (_input, init) => {
      body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return Response.json({
        ticket: "t",
        relay_origin: "https://relay.example.test",
        expires_at_ms: 1,
        route_epoch: "1",
      });
    };
    const client = new ControlClient({ origin, fetch: fetcher });
    await client.issueRelayTicket({ deviceId: "host-1", deviceCredential: "poc_dev_secret" });
    expect(body).toEqual({ device_id: "host-1", route_ids: [] });
  });

  test("issueRelayTicket rejects a response with a non-numeric-string route_epoch", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () =>
        Response.json({
          ticket: "t",
          relay_origin: "https://relay.example.test",
          expires_at_ms: 1,
          route_epoch: "not-a-number",
        }),
    });
    await expect(
      client.issueRelayTicket({ deviceId: "host-1", deviceCredential: "poc_dev_secret" }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  test("getRouteRecipientDevice authenticates with the device credential and sends the documented request", async () => {
    const requests: { pathname: string; authorization: string | null; body: unknown }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({
        pathname: new URL(requestUrl(input)).pathname,
        authorization: headers.get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ recipient_device_id: "mobile-1" });
    };
    const client = new ControlClient({ origin, fetch: fetcher });
    const result = await client.getRouteRecipientDevice({
      routeId: "route-1",
      deviceId: "host-1",
      deviceCredential: "poc_dev_secret",
    });
    expect(requests).toEqual([
      {
        pathname: "/v1/routes/route-1/recipient-device-id",
        authorization: "Bearer poc_dev_secret",
        body: { device_id: "host-1" },
      },
    ]);
    expect(result).toBe("mobile-1");
  });

  test("getRouteRecipientDevice URL-encodes the route id", async () => {
    let capturedPathname: string | undefined;
    const fetcher: typeof fetch = async (input) => {
      capturedPathname = new URL(requestUrl(input)).pathname;
      return Response.json({ recipient_device_id: "mobile-1" });
    };
    const client = new ControlClient({ origin, fetch: fetcher });
    await client.getRouteRecipientDevice({
      routeId: "route/with-slash",
      deviceId: "host-1",
      deviceCredential: "poc_dev_secret",
    });
    expect(capturedPathname).toBe("/v1/routes/route%2Fwith-slash/recipient-device-id");
  });

  test("getRouteRecipientDevice rejects a non-2xx response without leaking the credential", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () => new Response("denied", { status: 400 }),
    });
    await expect(
      client.getRouteRecipientDevice({
        routeId: "route-1",
        deviceId: "host-1",
        deviceCredential: "poc_dev_secret",
      }),
    ).rejects.toMatchObject({ code: "HTTP_STATUS" });
    try {
      await client.getRouteRecipientDevice({
        routeId: "route-1",
        deviceId: "host-1",
        deviceCredential: "poc_dev_secret",
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).not.toContain("poc_dev_secret");
    }
  });

  test("getRouteRecipientDevice rejects a response missing recipient_device_id", async () => {
    const client = new ControlClient({
      origin,
      fetch: async () => Response.json({}),
    });
    await expect(
      client.getRouteRecipientDevice({
        routeId: "route-1",
        deviceId: "host-1",
        deviceCredential: "poc_dev_secret",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

import { describe, expect, test } from "bun:test";
import { DEVICE_CREDENTIAL_PREFIX, isValidDeviceCredential } from "../src/credential-validation";
import {
  RELAY_TICKET_REFRESH_MARGIN_MS,
  RelayTicketAuthError,
  RelayTicketClient,
  RelayTicketRequestError,
  relayTicketNeedsRefresh,
  requestRelayTicket,
  type RelayTicketFetch,
} from "../src/relay-ticket";

const CREDENTIAL = {
  deviceId: "device-1",
  credential: `${DEVICE_CREDENTIAL_PREFIX}${"a1".repeat(32)}`,
};

function jsonResponse(status: number, body: unknown): ReturnType<RelayTicketFetch> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function validTicketBody(expiresAtMs: number): Record<string, unknown> {
  return {
    ticket: "ticket-value",
    relay_origin: "https://relay.example",
    expires_at_ms: expiresAtMs,
    route_epoch: "1",
  };
}

describe("relayTicketNeedsRefresh", () => {
  const ticket = {
    ticket: "t",
    relayOrigin: "https://relay.example",
    expiresAtMs: 1_000_000,
    routeEpoch: "1",
  };

  test("does not need a refresh well before expiry", () => {
    expect(relayTicketNeedsRefresh(ticket, 1_000_000 - 600_000)).toBeFalse();
  });

  test("needs a refresh once inside the safety margin", () => {
    expect(
      relayTicketNeedsRefresh(ticket, 1_000_000 - RELAY_TICKET_REFRESH_MARGIN_MS + 1),
    ).toBeTrue();
  });

  test("needs a refresh exactly at the margin boundary", () => {
    expect(relayTicketNeedsRefresh(ticket, 1_000_000 - RELAY_TICKET_REFRESH_MARGIN_MS)).toBeTrue();
  });

  test("needs a refresh after expiry", () => {
    expect(relayTicketNeedsRefresh(ticket, 1_000_001)).toBeTrue();
  });

  test("honors a custom margin", () => {
    expect(relayTicketNeedsRefresh(ticket, 999_000, 500)).toBeFalse();
    expect(relayTicketNeedsRefresh(ticket, 999_600, 500)).toBeTrue();
  });
});

describe("requestRelayTicket", () => {
  test("posts the device credential as a bearer token and returns the parsed ticket", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: Parameters<RelayTicketFetch>[1] | undefined;
    const fetchStub: RelayTicketFetch = (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, validTicketBody(700_000));
    };
    const ticket = await requestRelayTicket(
      { fetch: fetchStub, now: () => 100_000, controlUrl: "https://control.example" },
      CREDENTIAL,
    );
    expect(ticket).toEqual({
      ticket: "ticket-value",
      relayOrigin: "https://relay.example",
      expiresAtMs: 700_000,
      routeEpoch: "1",
    });
    expect(capturedUrl).toBe("https://control.example/v1/relay-tickets");
    expect(capturedInit?.method).toBe("POST");
    expect(capturedInit?.headers.authorization).toBe(`Bearer ${CREDENTIAL.credential}`);
    expect(JSON.parse(capturedInit?.body ?? "{}")).toEqual({
      device_id: CREDENTIAL.deviceId,
      route_ids: [],
    });
  });

  test("forwards requested route ids", async () => {
    let capturedBody: string | undefined;
    const fetchStub: RelayTicketFetch = (_url, init) => {
      capturedBody = init.body;
      return jsonResponse(200, validTicketBody(700_000));
    };
    await requestRelayTicket(
      { fetch: fetchStub, now: () => 0, controlUrl: "https://control.example" },
      CREDENTIAL,
      ["route-1", "route-2"],
    );
    expect(JSON.parse(capturedBody ?? "{}")).toEqual({
      device_id: CREDENTIAL.deviceId,
      route_ids: ["route-1", "route-2"],
    });
  });

  test("rejects a malformed device credential before making a network call", async () => {
    let called = false;
    const fetchStub: RelayTicketFetch = () => {
      called = true;
      return jsonResponse(200, validTicketBody(1));
    };
    await expect(
      requestRelayTicket(
        { fetch: fetchStub, now: () => 0, controlUrl: "https://control.example" },
        { deviceId: "device-1", credential: "not-a-credential" },
      ),
    ).rejects.toThrow();
    expect(called).toBeFalse();
  });

  test("converts a non-2xx response into a RelayTicketRequestError carrying the status", async () => {
    const fetchStub: RelayTicketFetch = () => jsonResponse(500, { error: "boom" });
    const error = await requestRelayTicket(
      { fetch: fetchStub, now: () => 0, controlUrl: "https://control.example" },
      CREDENTIAL,
    ).catch((caught: unknown) => caught);
    if (!(error instanceof RelayTicketRequestError))
      throw new Error("expected a RelayTicketRequestError");
    expect(error).not.toBeInstanceOf(RelayTicketAuthError);
    expect(error.status).toBe(500);
  });

  test.each([401, 403])(
    "converts a %d response into a distinguishable RelayTicketAuthError instead of retrying blindly",
    async (status) => {
      const fetchStub: RelayTicketFetch = () => jsonResponse(status, { error: "denied" });
      const error = await requestRelayTicket(
        { fetch: fetchStub, now: () => 0, controlUrl: "https://control.example" },
        CREDENTIAL,
      ).catch((caught: unknown) => caught);
      if (!(error instanceof RelayTicketAuthError))
        throw new Error("expected a RelayTicketAuthError");
      expect(error).toBeInstanceOf(RelayTicketRequestError);
      expect(error.status).toBe(status);
    },
  );

  test("rejects a response missing required fields", async () => {
    const fetchStub: RelayTicketFetch = () => jsonResponse(200, { ticket: "only-a-ticket" });
    await expect(
      requestRelayTicket(
        { fetch: fetchStub, now: () => 0, controlUrl: "https://control.example" },
        CREDENTIAL,
      ),
    ).rejects.toThrow();
  });

  test("never echoes the device credential or issued ticket in any thrown error message", async () => {
    const ticketMarker = "TICKET_SECRET_MARKER";
    const credentialMarker = `${DEVICE_CREDENTIAL_PREFIX}${"bb".repeat(32)}`;
    expect(isValidDeviceCredential(credentialMarker)).toBeTrue();

    // Malformed credential path.
    const invalidCredentialError = await requestRelayTicket(
      {
        fetch: () => jsonResponse(200, validTicketBody(1)),
        now: () => 0,
        controlUrl: "https://control.example",
      },
      { deviceId: "device-1", credential: "poc_dev_not-hex" },
    ).catch((caught: unknown) => caught);
    expect(
      invalidCredentialError instanceof Error ? invalidCredentialError.message : "",
    ).not.toContain("poc_dev_not-hex");

    // Non-2xx path: response body must not leak into the error message.
    const httpError = await requestRelayTicket(
      {
        fetch: () => jsonResponse(500, { ticket: ticketMarker, credential: credentialMarker }),
        now: () => 0,
        controlUrl: "https://control.example",
      },
      CREDENTIAL,
    ).catch((caught: unknown) => caught);
    expect(httpError instanceof Error ? httpError.message : "").not.toContain(ticketMarker);
    expect(httpError instanceof Error ? httpError.message : "").not.toContain(credentialMarker);

    // Malformed-response path: an embedded ticket value in an otherwise
    // invalid body must not leak into the validation error message.
    const parseError = await requestRelayTicket(
      {
        fetch: () =>
          jsonResponse(200, {
            ticket: ticketMarker,
            relay_origin: "https://relay.example",
            expires_at_ms: "not-a-number",
            route_epoch: "1",
          }),
        now: () => 0,
        controlUrl: "https://control.example",
      },
      CREDENTIAL,
    ).catch((caught: unknown) => caught);
    expect(parseError instanceof Error ? parseError.message : "").not.toContain(ticketMarker);
  });
});

describe("RelayTicketClient", () => {
  test("caches a ticket and does not re-fetch within the safety margin", async () => {
    let calls = 0;
    let now = 0;
    const client = new RelayTicketClient({
      fetch: () => {
        calls += 1;
        return jsonResponse(200, validTicketBody(600_000));
      },
      now: () => now,
      controlUrl: "https://control.example",
    });
    const first = await client.getTicket(CREDENTIAL);
    expect(calls).toBe(1);
    now = 600_000 - RELAY_TICKET_REFRESH_MARGIN_MS - 1;
    const second = await client.getTicket(CREDENTIAL);
    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  test("re-fetches once the cached ticket enters the refresh margin", async () => {
    let calls = 0;
    let now = 0;
    const client = new RelayTicketClient({
      fetch: () => {
        calls += 1;
        // First response is valid until 600_000; the refetched response is
        // valid until 1_200_000 so the test can tell the two apart.
        return jsonResponse(200, validTicketBody(calls === 1 ? 600_000 : 1_200_000));
      },
      now: () => now,
      controlUrl: "https://control.example",
    });
    await client.getTicket(CREDENTIAL);
    expect(calls).toBe(1);
    now = 600_000 - RELAY_TICKET_REFRESH_MARGIN_MS;
    const refreshed = await client.getTicket(CREDENTIAL);
    expect(calls).toBe(2);
    expect(refreshed.expiresAtMs).toBe(1_200_000);
  });

  test("invalidate() forces the next call to fetch a fresh ticket", async () => {
    let calls = 0;
    const client = new RelayTicketClient({
      fetch: () => {
        calls += 1;
        return jsonResponse(200, validTicketBody(600_000));
      },
      now: () => 0,
      controlUrl: "https://control.example",
    });
    await client.getTicket(CREDENTIAL);
    client.invalidate();
    await client.getTicket(CREDENTIAL);
    expect(calls).toBe(2);
  });
});

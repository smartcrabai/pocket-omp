import {
  PostgresAccountRepository,
  PostgresAdminSecurity,
  PostgresControlStore,
  PostgresDeviceRepository,
  PostgresEntitlementRepository,
  PostgresRelayDiagnosticsReader,
  SystemClock,
  UuidV7Generator,
} from "@pocket-omp/control-adapters";
import {
  AdminApplication,
  accountId,
  type AdminPrincipal,
  type AdminRole,
} from "@pocket-omp/control-core";
import { createRemoteJWKSet, jwtVerify } from "jose";

const controlDatabaseUrl = requiredEnvironment("CONTROL_DATABASE_URL");
const relayDatabaseUrl = requiredEnvironment("RELAY_DIAGNOSTICS_DATABASE_URL");
const staffIssuer = requiredEnvironment("STAFF_SSO_ISSUER");
const staffAudience = requiredEnvironment("STAFF_SSO_AUDIENCE");
const staffJwks = createRemoteJWKSet(new URL(requiredEnvironment("STAFF_SSO_JWKS_URL")));
const bind = process.env.ADMIN_BIND ?? "127.0.0.1";
const port = Number(process.env.ADMIN_PORT ?? "8090");
if (
  (!isLoopback(bind) && process.env.ALLOW_PRIVATE_NETWORK_BIND !== "true") ||
  !Number.isSafeInteger(port) ||
  port <= 0 ||
  port > 65_535
) {
  throw new Error("Admin API requires an explicit private-network bind and valid port");
}

const store = await PostgresControlStore.connect(controlDatabaseUrl);
await store.migrate();
const relayDiagnostics = await PostgresRelayDiagnosticsReader.connect(relayDatabaseUrl);
const security = new PostgresAdminSecurity(store);
const application = new AdminApplication(
  security,
  security,
  new PostgresAccountRepository(store),
  new PostgresDeviceRepository(store),
  new PostgresEntitlementRepository(store),
  relayDiagnostics,
  new SystemClock(),
  new UuidV7Generator(),
);

const staticHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const server = Bun.serve({
  hostname: bind,
  port,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz")
      return new Response("ok", { headers: { "cache-control": "no-store" } });
    if (url.pathname === "/") return staticFile("index.html", "text/html; charset=utf-8");
    if (url.pathname === "/app.js") return staticFile("app.js", "text/javascript; charset=utf-8");
    if (url.pathname === "/app.css") return staticFile("app.css", "text/css; charset=utf-8");
    if (url.pathname !== "/api/diagnostics" || request.method !== "GET")
      return new Response("Not found", { status: 404, headers: staticHeaders });
    try {
      const principal = await authenticate(request);
      const account = accountId(requiredQuery(url, "account_id"));
      const grantId = requiredQuery(url, "grant_id");
      const correlationId = request.headers.get("x-correlation-id") ?? Bun.randomUUIDv7();
      const diagnostics = await application.getAccountDiagnostics(
        principal,
        account,
        grantId,
        correlationId,
      );
      return jsonResponse(diagnostics, 200, { "x-correlation-id": correlationId });
    } catch (error) {
      const denied =
        error instanceof Error &&
        (error.message.includes("denied") || error.message.includes("JWT"));
      return jsonResponse(
        { code: denied ? "ACCESS_DENIED" : "INVALID_REQUEST" },
        denied ? 403 : 400,
      );
    }
  },
});

async function authenticate(request: Request): Promise<AdminPrincipal> {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ") !== true) throw new Error("JWT required");
  const verified = await jwtVerify(authorization.slice(7), staffJwks, {
    issuer: staffIssuer,
    audience: staffAudience,
    algorithms: ["EdDSA", "ES256", "RS256"],
  });
  if (typeof verified.payload.sub !== "string" || verified.payload.sub.length === 0)
    throw new Error("JWT subject required");
  const roles = adminRoles(verified.payload.roles);
  const authenticatedAtMs = secondsToMilliseconds(verified.payload.iat);
  const stepUpAtMs =
    verified.payload.step_up_at === undefined
      ? undefined
      : secondsToMilliseconds(verified.payload.step_up_at);
  return {
    staffSubject: verified.payload.sub,
    roles,
    authenticatedAtMs,
    ...(stepUpAtMs === undefined ? {} : { stepUpAtMs }),
  };
}

function adminRoles(value: unknown): ReadonlySet<AdminRole> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter(isAdminRole));
}

function isAdminRole(value: unknown): value is AdminRole {
  return (
    value === "support-read" ||
    value === "support-write" ||
    value === "billing-admin" ||
    value === "security-admin"
  );
}

function secondsToMilliseconds(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid JWT timestamp");
  return BigInt(value) * 1_000n;
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null || value.length === 0 || value.length > 256)
    throw new Error(`${name} is required`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function jsonResponse(
  value: unknown,
  status: number,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
    {
      status,
      headers: { ...staticHeaders, ...headers, "content-type": "application/json; charset=utf-8" },
    },
  );
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function staticFile(name: "index.html" | "app.js" | "app.css", contentType: string): Response {
  return new Response(Bun.file(new URL(name, import.meta.url)), {
    headers: { ...staticHeaders, "content-type": contentType },
  });
}

async function shutdown(): Promise<void> {
  await server.stop(false);
  await Promise.all([store.close(), relayDiagnostics.close()]);
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
console.log(`Admin API listening on http://${bind}:${port}`);

import { ReviewHost, ReviewHostError } from "./core";

const enabled = process.env.REVIEW_HOST_ENABLED === "true";
const purpose = process.env.DEPLOYMENT_PURPOSE;
const accountId = process.env.REVIEW_ACCOUNT_ID;
const accessToken = process.env.REVIEW_HOST_ACCESS_TOKEN;
if (
  !enabled ||
  purpose !== "app-review" ||
  accountId === undefined ||
  accessToken === undefined ||
  accessToken.length < 32
)
  throw new Error(
    "Review Host requires an isolated app-review deployment and dedicated credentials",
  );
const host = new ReviewHost(accountId, () => Bun.randomUUIDv7());
const port = Number(process.env.PORT ?? 8080);

Bun.serve({
  port,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health/live") return Response.json({ status: "ok", purpose });
    if (request.headers.get("authorization") !== `Bearer ${accessToken}`)
      return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    try {
      const body: unknown = request.method === "POST" ? await request.json() : undefined;
      if (url.pathname === "/v1/review/sessions" && request.method === "POST") {
        if (!record(body) || typeof body.account_id !== "string")
          return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
        return Response.json(host.start(body.account_id), { status: 201 });
      }
      const match = /^\/v1\/review\/sessions\/([^/]+)\/approval$/.exec(url.pathname);
      if (match !== null && request.method === "POST") {
        const sessionId = match[1];
        if (
          sessionId === undefined ||
          !record(body) ||
          typeof body.account_id !== "string" ||
          typeof body.allow !== "boolean"
        )
          return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
        return Response.json({ events: host.approve(body.account_id, sessionId, body.allow) });
      }
      return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    } catch (error) {
      if (error instanceof ReviewHostError)
        return Response.json(
          { code: error.code },
          { status: error.code === "ACCOUNT_DENIED" ? 403 : 404 },
        );
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    }
  },
});
console.log(`Review Host listening on ${port}`);
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

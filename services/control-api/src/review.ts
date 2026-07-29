import { DurableObject } from "cloudflare:workers";

export interface ReviewEvent {
  readonly revision: number;
  readonly kind: "message" | "tool" | "approval" | "file" | "attachment" | "complete";
  readonly payload: Readonly<Record<string, string | boolean>>;
}

interface EventRow extends Record<string, SqlStorageValue> {
  revision: number;
  kind: ReviewEvent["kind"];
  payload: string;
}

export class ReviewSession extends DurableObject<Env> {
  public constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS review_session (
          session_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          completed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS review_event (
          session_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          PRIMARY KEY (session_id, revision),
          FOREIGN KEY (session_id) REFERENCES review_session(session_id) ON DELETE CASCADE
        );
      `);
    });
  }

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/sessions" && request.method === "POST") return this.start(request);
    const match = /^\/sessions\/([^/]+)\/approval$/.exec(url.pathname);
    if (match !== null && request.method === "POST") {
      const sessionId = match[1];
      if (sessionId !== undefined) return this.approve(sessionId, request);
    }
    return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  }

  private async start(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.accountId !== "string" || body.accountId.length === 0)
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    const sessionId = crypto.randomUUID();
    const events: readonly ReviewEvent[] = [
      {
        revision: 1,
        kind: "message",
        payload: {
          role: "assistant",
          text: "Review workspace is ready. No production data or provider credential is connected.",
        },
      },
      {
        revision: 2,
        kind: "tool",
        payload: { tool: "read", status: "completed", summary: "Read sample workspace status" },
      },
      {
        revision: 3,
        kind: "approval",
        payload: {
          approval_id: `approval-${sessionId}`,
          summary: "Write review-note.txt in the sample workspace",
          pending: true,
        },
      },
    ];
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO review_session (session_id, account_id) VALUES (?, ?)",
        sessionId,
        body.accountId,
      );
      for (const event of events)
        this.ctx.storage.sql.exec(
          "INSERT INTO review_event (session_id, revision, kind, payload) VALUES (?, ?, ?, ?)",
          sessionId,
          event.revision,
          event.kind,
          JSON.stringify(event.payload),
        );
    });
    return Response.json({ sessionId, events }, { status: 201 });
  }

  private async approve(sessionId: string, request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (!isRecord(body) || typeof body.accountId !== "string" || typeof body.allow !== "boolean")
      return Response.json({ code: "INVALID_REQUEST" }, { status: 400 });
    const session = this.ctx.storage.sql
      .exec<{ account_id: string; completed: number }>(
        "SELECT account_id, completed FROM review_session WHERE session_id = ?",
        sessionId,
      )
      .toArray()[0];
    if (session === undefined || session.account_id !== body.accountId)
      return Response.json({ code: "SESSION_NOT_FOUND" }, { status: 404 });
    if (session.completed === 0) {
      const completionEvents: readonly ReviewEvent[] = [
        {
          revision: 4,
          kind: "approval",
          payload: { approval_id: `approval-${sessionId}`, allowed: body.allow },
        },
        ...(body.allow
          ? [
              {
                revision: 5,
                kind: "file" as const,
                payload: { path: "review-note.txt", status: "created" },
              },
              {
                revision: 6,
                kind: "attachment" as const,
                payload: { name: "review-result.txt", encrypted: true },
              },
            ]
          : []),
        {
          revision: body.allow ? 7 : 5,
          kind: "complete",
          payload: { outcome: body.allow ? "completed" : "denied" },
        },
      ];
      this.ctx.storage.transactionSync(() => {
        for (const event of completionEvents)
          this.ctx.storage.sql.exec(
            "INSERT INTO review_event (session_id, revision, kind, payload) VALUES (?, ?, ?, ?)",
            sessionId,
            event.revision,
            event.kind,
            JSON.stringify(event.payload),
          );
        this.ctx.storage.sql.exec(
          "UPDATE review_session SET completed = 1 WHERE session_id = ?",
          sessionId,
        );
      });
    }
    const events = this.ctx.storage.sql
      .exec<EventRow>(
        "SELECT revision, kind, payload FROM review_event WHERE session_id = ? ORDER BY revision",
        sessionId,
      )
      .toArray()
      .map(
        (event) =>
          ({
            revision: event.revision,
            kind: event.kind,
            payload: parsePayload(event.payload),
          }) satisfies ReviewEvent,
      );
    return Response.json({ events });
  }
}

function parsePayload(value: string): Record<string, string | boolean> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Stored review event payload is invalid");
  const payload: Record<string, string | boolean> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (typeof item !== "string" && typeof item !== "boolean")
      throw new Error("Stored review event payload is invalid");
    payload[key] = item;
  }
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

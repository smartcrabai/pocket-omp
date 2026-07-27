export interface ReviewEvent {
  readonly revision: number;
  readonly kind: "message" | "tool" | "approval" | "file" | "attachment" | "complete";
  readonly payload: Readonly<Record<string, string | boolean>>;
}
export class ReviewHost {
  private readonly sessions = new Map<string, { accountId: string; events: ReviewEvent[] }>();
  public constructor(
    private readonly reviewAccountId: string,
    private readonly ids: () => string,
  ) {
    if (!/^[\x21-\x7e]{1,128}$/.test(reviewAccountId))
      throw new ReviewHostError("INVALID_CONFIGURATION", "Review account is required");
  }
  public start(accountId: string): {
    readonly sessionId: string;
    readonly events: readonly ReviewEvent[];
  } {
    this.authorize(accountId);
    const sessionId = this.ids();
    const events: ReviewEvent[] = [
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
    this.sessions.set(sessionId, { accountId, events });
    return { sessionId, events };
  }
  public approve(accountId: string, sessionId: string, allow: boolean): readonly ReviewEvent[] {
    this.authorize(accountId);
    const session = this.sessions.get(sessionId);
    if (session?.accountId !== accountId)
      throw new ReviewHostError("SESSION_NOT_FOUND", "Review session not found");
    if (session.events.some((event) => event.kind === "complete")) return session.events;
    session.events.push(
      {
        revision: 4,
        kind: "approval",
        payload: { approval_id: `approval-${sessionId}`, allowed: allow },
      },
      ...(allow
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
        revision: allow ? 7 : 5,
        kind: "complete",
        payload: { outcome: allow ? "completed" : "denied" },
      },
    );
    return session.events;
  }
  private authorize(accountId: string): void {
    if (accountId !== this.reviewAccountId)
      throw new ReviewHostError("ACCOUNT_DENIED", "Review Host account is denied");
  }
}
export class ReviewHostError extends Error {
  public constructor(
    public readonly code: "INVALID_CONFIGURATION" | "ACCOUNT_DENIED" | "SESSION_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ReviewHostError";
  }
}

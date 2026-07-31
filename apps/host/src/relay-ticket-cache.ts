// Caches short-lived relay tickets (ADR-009: Control issues tickets valid
// for at most 10 minutes) behind a safety margin, so callers driving
// RelayGateway never race a ticket's expiry mid-flight and don't pay a
// Control Plane round trip on every relay operation.
//
// Margin: 60s, i.e. 10% of the 600s ticket lifetime
// (TICKET_LIFETIME_SECONDS in services/control-api/src/control.ts). This
// must comfortably absorb, on any single use of a resolved ticket:
//   - Host<->Control clock skew (most hosts are NTP-synced to within a few
//     seconds, but that isn't guaranteed for every environment Host runs on)
//   - the /v1/relay-tickets round trip latency itself, including a retry
//   - the gap between resolving a ticket here and it actually being
//     presented to Relay (a WebSocket handshake or an HTTP call)
// Each of those is normally sub-second, so 60s is generous, while still
// keeping re-issuance rare (at most once per ~9 minutes of continuous use).
// apps/mobile/src/relay-ticket.ts arrived at the same 60s/10% figure
// independently for the same reasons, which is a useful cross-check that
// the number is not arbitrary.
export const DEFAULT_RELAY_TICKET_REFRESH_MARGIN_MS = 60_000n;

export interface RelayTicketIssueResult {
  readonly ticket: string;
  readonly relayOrigin: string;
  readonly expiresAtMs: bigint;
}

export interface RelayTicketCacheOptions {
  readonly issue: () => Promise<RelayTicketIssueResult>;
  readonly now?: () => bigint;
  readonly refreshMarginMs?: bigint;
}

export class RelayTicketCache {
  private readonly issue: () => Promise<RelayTicketIssueResult>;
  private readonly now: () => bigint;
  private readonly refreshMarginMs: bigint;
  private cached: RelayTicketIssueResult | undefined;
  private pending: Promise<RelayTicketIssueResult> | undefined;

  public constructor(options: RelayTicketCacheOptions) {
    const refreshMarginMs = options.refreshMarginMs ?? DEFAULT_RELAY_TICKET_REFRESH_MARGIN_MS;
    if (refreshMarginMs < 0n) {
      throw new RelayTicketCacheError("INVALID_MARGIN", "refreshMarginMs must not be negative");
    }
    this.issue = options.issue;
    this.now = options.now ?? (() => BigInt(Date.now()));
    this.refreshMarginMs = refreshMarginMs;
  }

  public async ticket(): Promise<string> {
    return (await this.resolve()).ticket;
  }

  public async relayOrigin(): Promise<string> {
    return (await this.resolve()).relayOrigin;
  }

  // Forces the next resolve() to fetch a fresh ticket, e.g. after the
  // caller observes Relay reject the cached ticket out of band.
  public invalidate(): void {
    this.cached = undefined;
  }

  private async resolve(): Promise<RelayTicketIssueResult> {
    const cached = this.cached;
    if (cached !== undefined && this.now() + this.refreshMarginMs < cached.expiresAtMs) {
      return cached;
    }
    // Concurrent callers during a refresh share the same in-flight request
    // rather than each issuing their own ticket.
    this.pending ??= this.refresh();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async refresh(): Promise<RelayTicketIssueResult> {
    const issued = await this.issue();
    this.cached = issued;
    return issued;
  }
}

export class RelayTicketCacheError extends Error {
  public constructor(
    public readonly code: "INVALID_MARGIN",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RelayTicketCacheError";
  }
}

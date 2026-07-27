# ADR-009: Short-Lived Relay Tickets and Durable Invalidation

## Decision
Control issues Ed25519-signed tickets valid for at most 10 minutes, and Relay validates them locally with JWKS. Durable events communicate immediate revocation.

## Context
Revocation delay must be bounded without a synchronous Control lookup for every Relay request.

## Options
We compared long-lived credentials, opaque-token introspection, and short-lived signed tickets.

## Consequences
Tickets bind device, route, region, epoch, and entitlement. TTL remains the upper bound when an event is missed.

## Reconsider When
Ticket TTL or revocation SLO requirements cannot be met.

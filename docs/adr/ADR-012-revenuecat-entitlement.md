# ADR-012: Single Entitlement Through RevenueCat

## Decision
Normalize monthly and annual products to `relay_pro`, and use `usableUntil` in the Control database as the source of truth for Relay authorization.

## Context
Differences between iOS and Android stores, grace periods, billing retries, and refunds must be handled consistently.

## Options
We compared direct store integration, an in-house billing aggregator, and RevenueCat.

## Consequences
Webhook signatures are verified and processing is idempotent by event ID. Periodic reconciliation recovers missed events.

## Reconsider When
RevenueCat SLOs, pricing, or store support no longer meet product requirements.

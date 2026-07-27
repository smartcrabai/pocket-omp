# ADR-010: Separate Control and Relay Database Ownership

## Decision
In production, Control and each Relay region have independent database owners and clusters. Cross-context joins and direct access are prohibited.

## Context
Failure, permission, and migration boundaries must align with context responsibilities.

## Options
We compared a shared schema, separate schemas in a shared cluster, and independent owners and clusters.

## Consequences
Integration is limited to tickets, internal events, and private Connect services.

## Reconsider When
Contexts are merged or data ownership changes.

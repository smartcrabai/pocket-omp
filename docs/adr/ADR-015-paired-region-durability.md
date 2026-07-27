# ADR-015: Synchronous Paired-Region Durability

## Decision
Return `Accepted` only after message, deduplication, and sequence data are durable in both home and standby, and home confirms deliverability.

## Context
Accepted messages require RPO 0 after region loss.

## Options
We compared a single region, asynchronous cross-region replication, and synchronous paired regions.

## Consequences
A standby failure prevents success and leaves work in the repair outbox. We accept the latency and availability cost of synchronous writes.

## Reconsider When
SLOs or latency in supported regions cannot meet the defined requirements.

# ADR-007: PostgreSQL as the Delivery Source of Truth

## Decision
Store ciphertext, sequences, and cursors in PostgreSQL. Use Redis only for wake-ups, durable invalidation, and rate limiting.

## Context
Redis notification loss must not become message loss.

## Options
We compared Redis Streams, Kafka, and PostgreSQL as the source of truth.

## Consequences
When Redis is unavailable, delivery degrades to database polling. A transactional outbox recovers missed notifications.

## Reconsider When
Measured PostgreSQL sequence hotspots cannot be resolved.

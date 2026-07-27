# ADR-006: At-Least-Once Delivery and Application Idempotency

## Decision
Network delivery is ordered and at least once per recipient; Host executes commands exactly once using a persistent `command_id`.

## Context
Network-level exactly-once delivery cannot be guaranteed across disconnections and retries.

## Options
We compared at-most-once delivery, simulated network exactly-once delivery, and at-least-once delivery with endpoint idempotency.

## Consequences
Relay deduplicates by `sender_device_id + message_id`, Host by `command_id`, and Mobile by `event_id + revision`.

## Reconsider When
The delivery protocol receives a major-version change.

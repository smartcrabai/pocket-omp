# ADR-004: Server-Streaming Downlink and Unary Batch Uplink

## Decision
Use Connect `Subscribe` server streaming for downlink and idempotent `Publish` unary batches for uplink.

## Context
A request-body stream cannot be assumed to survive while Mobile is in the background.

## Options
We compared bidirectional streaming, polling, and server streaming plus unary requests.

## Consequences
ACKs and cursors are explicit, and the protocol works over HTTP/1.1. Uplink batches are limited to 64 envelopes or 2 MiB.

## Reconsider When
Mobile platforms and ingress consistently support bidirectional transport.

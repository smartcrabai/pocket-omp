# ADR-022: Host-to-Runtime Length-Prefixed Protobuf IPC

## Decision
Exchange `uint32_be length + pocket.omp.runtime.v1.RuntimeFrame` over stdin/stdout.

## Context
Process isolation and generation fencing are required without leaking raw SDK events.

## Options
We compared JSON Lines, OMP RPC, and dedicated binary Protobuf.

## Consequences
Stdout is reserved for IPC. A 1 MiB physical limit, 32 MiB logical limit, chunk hashes, heartbeats, and request correlation are enforced.

## Reconsider When
The IPC transport or Runtime process model changes.

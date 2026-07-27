# ADR-023: CLI-to-Host Daemon Local Control

## Decision
Use Unix domain sockets on macOS/Linux and named pipes on Windows, with current-user ACLs and a short-lived local secret for mutual verification.

## Context
The administration CLI and TUI handoff need local control, but a PC-side TCP listening port is prohibited.

## Options
We compared localhost TCP, a file command queue, and UDS/named pipes.

## Consequences
CLI requests handoff from Daemon instead of modifying session files directly. Frame limits and peer credentials are verified.

## Reconsider When
A stronger standard local RPC becomes available on every supported OS.

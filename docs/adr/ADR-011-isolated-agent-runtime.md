# ADR-011: OMP SDK in an Isolated Bun Agent Runtime

## Decision
Run the OMP SDK in a Bun child process for each active session; do not load it into Host Daemon.

## Context
Failures in extensions, MCP, LSP, providers, or native dependencies must be isolated from Relay connections, keys, and ownership.

## Options
We compared running in the Host process, OMP RPC mode, and a dedicated SDK Runtime.

## Consequences
Host and Runtime use versioned Protobuf IPC, and SDK types do not cross the boundary.

## Reconsider When
The OMP SDK officially provides equivalent fault isolation.

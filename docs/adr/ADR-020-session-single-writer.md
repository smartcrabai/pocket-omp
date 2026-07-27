# ADR-020: TUI/Pocket Single-Writer Ownership

## Decision
Enforce one writer per session with an ownership lease, sidecar lock, file fingerprint monitoring, and managed handoff.

## Context
The OMP TUI does not recognize the Pocket lock, so concurrent writes can corrupt a session.

## Options
We compared optimistic merging, OS file locks alone, and layered detection with explicit handoff.

## Consequences
When external mutation is detected, stop new commands, dispose the Runtime, and transition to `CONFLICT`.

## Reconsider When
OMP officially provides a cross-process ownership protocol.

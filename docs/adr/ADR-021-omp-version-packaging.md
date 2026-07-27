# ADR-021: OMP SDK/TUI Exact-Version Packaging

## Decision
Distribute the exact OMP SDK, same-release TUI, Runtime, Daemon, and CLI as one signed atomic release set for each Host release.

## Context
SDK/TUI/session-format skew can cause destructive migrations or failed resumes.

## Options
We compared a system OMP dependency, a semantic-version range, and an exact bundled release.

## Consequences
A backup before the first write, compatibility probes, `NEWER_THAN_RUNTIME` write rejection, and a rollback manifest are required.

## Reconsider When
OMP guarantees a long-term stable session ABI.

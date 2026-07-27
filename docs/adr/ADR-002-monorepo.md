# ADR-002: Single Cargo and Bun Monorepo

## Decision
Operate Cargo Workspace and Bun Workspaces in one repository, with `just` running cross-language gates.

## Context
Protocol and interoperability vector changes must be integrated atomically.

## Options
We compared separate repositories, one build system, and combined workspaces.

## Consequences
Lockfiles and build caches remain language-specific, and protocol changes require tests for both ecosystems.

## Reconsider When
Repository size makes checkout or CI time obstruct the release gate.

# ADR-019: Standard OMP File-Backed SessionManager as the Source of Truth

## Decision
Manage new and existing sessions only through OMP SDK `SessionManager.create/open/list`; do not create Pocket-specific session schemas or directories.

## Context
Bidirectional resume with the standard OMP TUI and session-format compatibility are required.

## Options
We compared a custom database, direct JSONL manipulation, and the official SessionManager.

## Consequences
Host SQLite stores only product metadata such as ownership and cursors; conversation content is not managed twice.

## Reconsider When
OMP replaces its official persistence API in a major release.

# ADR-017: Cross-Platform Host Secret Storage and Signed Updates

## Decision
Prefer the OS credential store, with an Argon2id vault fallback only on headless Linux. Sign update manifests with Ed25519 and apply release sets atomically.

## Context
Private keys must not be stored in ordinary files or SQLite, and partial updates must not create SDK/TUI skew.

## Options
We compared configuration files, a custom keyring, and OS stores with a limited fallback.

## Consequences
A platform adapter contract, staged rollout, checksums, and rollback are required.

## Reconsider When
OS APIs or distribution methods change.

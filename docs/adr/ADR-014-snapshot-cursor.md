# ADR-014: Snapshots and Cursor Replay

## Decision
Normal recovery replays deltas from the acknowledged cursor. Only a retention gap resets state from an encrypted snapshot.

## Context
Long offline periods and large transcripts must be recoverable without retaining events indefinitely.

## Options
We compared permanent full-history retention, snapshots only, and snapshots plus cursors.

## Consequences
A snapshot includes a state hash and base event, while Relay stores only ciphertext.

## Reconsider When
Retention or snapshot cadence changes.

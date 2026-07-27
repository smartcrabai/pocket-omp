# ADR-005: Pairwise E2EE

## Decision
Encrypt each Host-Mobile pair with X25519, HKDF-SHA-256, and XChaCha20-Poly1305.

## Context
Session content and content keys must remain hidden from Relay and Control, with revocation available per device.

## Options
We compared server-side encryption, an account-wide shared key, and pairwise keys.

## Consequences
Events for multiple Mobile devices are encrypted separately. Canonical AAD and shared vectors detect implementation differences.

## Reconsider When
Cryptographic primitives become vulnerable, platform Secure Store constraints change, or device limits change.

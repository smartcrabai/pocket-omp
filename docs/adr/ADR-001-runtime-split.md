# ADR-001: Rust Relay / Bun Services / Expo Mobile

## Decision
Long-lived connections and delivery use Rust; Control, Host, and Worker use Bun/TypeScript; Mobile uses Expo.

## Context
The delivery path needs predictable memory usage and high connection density, while surrounding features need the TypeScript ecosystem.

## Options
We compared an all-TypeScript implementation, an all-Rust implementation, and a language split by responsibility.

## Consequences
Language boundaries are limited to Protobuf and cryptographic vectors. The operational surface grows, but each responsibility uses a suitable runtime.

## Reconsider When
Measured load or maintenance cost invalidates the benefits of this split.

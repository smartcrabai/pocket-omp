# ADR-008: Isolate Generated Protobuf Types in Adapters

## Decision
Reference generated Protobuf types only in Protocol and Adapter layers, and always convert them to Domain or Application types.

## Context
Wire compatibility and Domain invariants change for different reasons.

## Options
We compared sharing generated types across all layers, handwritten wire types, and Adapter mapping.

## Consequences
Mapping code increases, but wire changes do not leak into Core. Rust Relay does not link session or runtime descriptors.

## Reconsider When
The cross-language contract makes a major migration away from Protobuf.

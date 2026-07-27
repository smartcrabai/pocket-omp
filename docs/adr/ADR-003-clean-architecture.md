# ADR-003: Clean Architecture per Bounded Context

## Decision
Separate Domain, Application, Adapter, and Composition Root layers for Relay, Control, Host/Runtime, and Mobile.

## Context
Allowing framework or generated types into business rules would reduce replaceability and unit-test isolation.

## Options
We compared no layers, repository-wide layers, and layers scoped to each context.

## Consequences
An architecture scanner and the crate graph reject dependencies from Core to Connect, databases, Expo, or the OMP SDK.

## Reconsider When
Context boundaries or responsibilities change.

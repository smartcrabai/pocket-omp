# ADR-016: Independent Worker and Admin Deployments

## Decision
Give Billing, Push, Cleanup, Outbox, and Reconcile Workers and the Admin API/UI independent workspaces, images, and service accounts.

## Context
Their permissions, load, failure scope, and release cadence differ.

## Options
We compared co-location with the Control API, one worker with command switching, and independent deployments.

## Consequences
The image count increases, but least privilege and resource isolation are enforced per deployment.

## Reconsider When
Deployments with fully identical responsibilities and permissions are identified.

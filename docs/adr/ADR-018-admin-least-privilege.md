# ADR-018: Admin Least Privilege and Immutable Audit

## Decision
Admin requires private ingress, staff SSO, step-up authentication, RBAC, expiring support grants, and append-only audit logs.

## Context
Support operations are themselves a high security risk and do not require access to session content.

## Options
We compared direct production database access, the shared Control API, and a dedicated Admin boundary.

## Consequences
Diagnostics are limited to minimal metadata and never return content, keys, provider credentials, or complete paths.

## Reconsider When
Support workflows or regulatory requirements change.

# ADR-013: Official Apps Use Only the Official Relay

## Decision
Store-distributed Mobile apps connect only to official Relay origins signed by Control.

## Context
Billing, push notifications, security response, and protocol compatibility need one operational contract.

## Options
We compared arbitrary self-hosted Relays, the official Relay, and support for both.

## Consequences
The Relay origin comes from a signed ticket claim rather than being hard-coded. Arbitrary URL input is not offered.

## Reconsider When
A self-hosted offering is approved as a separate product line.

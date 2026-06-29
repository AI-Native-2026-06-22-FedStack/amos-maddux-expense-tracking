# ADR-0002: Sprint-2 Polyglot Service Split

## Status

Proposed.

## Context

Sprint 2 is expected to evaluate whether ExpenseFlow should split responsibilities across `Core Case`, `Domain Compute`, and `Identity`. The storage decision in [ADR-0001](0001-store-expense-report-case-in-postgresql-with-drizzle.md) centralizes the Expense Report Case, so any future split needs clear ownership of case persistence, workflow transitions, computed domain behavior, and identity boundaries.

## Decision

Propose a future polyglot service split with `Core Case`, `Domain Compute`, and `Identity` as candidate service boundaries. This ADR does not accept the split yet.

## Consequences

POSITIVE: The proposed split gives Sprint 2 a named architecture direction for separating case ownership, domain computation, and identity concerns.
POSITIVE: Linking the proposal to ADR-0001 keeps future service-boundary discussions traceable to the accepted PostgreSQL and Drizzle storage choice.
NEGATIVE: Splitting services would add deployment, observability, API contract, and cross-service testing overhead.
NEGATIVE: Separating responsibilities too early could slow feature delivery if the team has not proven the boundaries through implementation experience.

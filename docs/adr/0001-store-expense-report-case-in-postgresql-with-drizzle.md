# ADR-0001: Store Expense Report Case in PostgreSQL with Drizzle

## Status

Accepted.

## Context

ExpenseFlow needs one central persistence stack so all developers share the same durable case model and query patterns. The primary case is `Expense Report`, and the supported workflow has six stages: `Drafted`, `Submitted`, `Manager Approval`, `AP Review`, `Paid`, and `Reconciled`. ExpenseFlow also needs tenant-scoped records to preserve multi-tenant isolation so one tenant cannot read, write, infer, search, export, or receive another tenant's data.

## Decision

Store the Expense Report Case in PostgreSQL and use Drizzle for TypeScript data access.

## Consequences

POSITIVE: PostgreSQL supports strong relational constraints, transactional updates, row-level security, and mature indexing options that fit tenant-scoped Expense Report workflow data.
POSITIVE: PostgreSQL gives the team a widely supported open-source database with strong TypeScript ecosystem support through Drizzle and clear paths for migrations, local development, and managed production hosting.
POSITIVE: Drizzle gives TypeScript developers typed query construction and schema definitions that keep application code aligned with the persistence model.
NEGATIVE: PostgreSQL commits the team to relational schema design, joins, indexes, and migration ordering, which can slow changes when the Expense Report Case shape is still evolving.
NEGATIVE: Drizzle keeps the TypeScript service close to PostgreSQL schema details, so schema changes can ripple into application code and require coordinated migration updates.

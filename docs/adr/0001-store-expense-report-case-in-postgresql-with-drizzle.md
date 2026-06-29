# ADR-0001: Store Expense Report Case in PostgreSQL with Drizzle

## Status

Accepted.

## Context

ExpenseFlow needs one central persistence stack so all developers share the same durable case model and query patterns. The primary case is `Expense Report`, and the supported workflow has six stages: `Drafted`, `Submitted`, `Manager Approval`, `AP Review`, `Paid`, and `Reconciled`. ExpenseFlow also needs tenant-scoped records to preserve multi-tenant isolation so one tenant cannot read, write, infer, search, export, or receive another tenant's data.

## Decision

Store the Expense Report Case in PostgreSQL and use Drizzle for TypeScript data access.

## Alternatives Considered

- **SQLite + Drizzle:** Rejected because SQLite is useful for lightweight local persistence, prototypes, and single-user applications, but ExpenseFlow is a production-style multi-tenant SaaS workflow system. Multiple employees, department managers, finance admins, and platform users may interact with expense reports at the same time: employees can submit or edit drafts, managers can approve or reject line items, AP reviewers can verify coding and deductibility, and finance admins can review audit history. That makes concurrent access important because the system must safely handle simultaneous reads and writes to case records, line items, comments, attachments, stage transitions, and audit logs without corrupting workflow state. PostgreSQL is a stronger fit because it provides mature concurrency handling, transactions, indexing, operational tooling, and support for database-level tenant isolation patterns such as row-level security.

- **MongoDB:** Rejected because ExpenseFlow’s core data is highly relational. An expense report belongs to a tenant, submitter, approval chain, workflow stage, line items, receipts, comments, flags, payments, and audit trail entries. The application also needs predictable tenant-scoped querying, role-gated workflow transitions, reliable joins, and transactional consistency when moving a case from one stage to another while recording the corresponding audit event. A document database could store nested expense-report data, but it would make cross-record consistency, reporting, indexing strategy, and relational constraints harder to enforce for this workflow-heavy finance application.

- **Raw SQL without an ORM/query builder:** Rejected because raw SQL would preserve full PostgreSQL capability, but it would reduce developer safety and consistency in a TypeScript codebase. ExpenseFlow has many tables that need to stay aligned with application types, including tenants, users, expense reports, line items, comments, attachments, workflow transitions, flags, and audit trail records. Writing raw SQL everywhere would increase the risk of mismatched column names, incorrect result shapes, inconsistent tenant filters, and missed workflow/audit updates. A typed ORM or query builder provides a safer middle ground: the project can still use PostgreSQL’s relational and transactional strengths while giving TypeScript developers better schema-query alignment and refactoring support.

## Consequences

POSITIVE: PostgreSQL supports strong relational constraints, transactional updates, row-level security, and mature indexing options that fit tenant-scoped Expense Report workflow data.
POSITIVE: PostgreSQL gives the team a widely supported open-source database with strong TypeScript ecosystem support through Drizzle and clear paths for migrations, local development, and managed production hosting.
POSITIVE: Drizzle gives TypeScript developers typed query construction and schema definitions that keep application code aligned with the persistence model.
NEGATIVE: PostgreSQL commits the team to relational schema design, joins, indexes, and migration ordering, which can slow changes when the Expense Report Case shape is still evolving.
NEGATIVE: Drizzle keeps the TypeScript service close to PostgreSQL schema details, so schema changes can ripple into application code and require coordinated migration updates.

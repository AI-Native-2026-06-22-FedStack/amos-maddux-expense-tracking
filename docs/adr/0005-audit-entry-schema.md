# ADR-0005: Audit Entry Schema

## Status

Accepted

## Context

ExpenseFlow needs an audit trail that auditors can rely on for every committed Expense Report state
change. Audit records must answer the fixed questions of who acted, what happened, when it happened,
why it happened, and whether the action succeeded or failed. The audit trail also needs tenant and
Expense Report references so entries can be queried for one case without storing receipt or payment
values in the audit record.

ADR-0004 is already assigned to the auth and session model, so this decision is recorded as
ADR-0005.

## Decision

Use `audit_entry` as the append-only store for Expense Report audit records. Each row carries
non-null storage columns `tenant_id` and `expense_report_id`, plus the five non-null audit
dimensions: actor, action, timestamp, reason, and result.

Represent the dimensions in PostgreSQL as `actor_id`, `action`, `occurred_at`, `reason`, and
`result`. Keep `result` as a closed enum of `success` and `failure`, enforced by a database check
constraint and by the Node zod write schema.

Validate audit entries with zod before insert. Missing fields, null fields, unknown fields, and
unknown result values are rejected before storage. The legacy nullable `details` column is removed so
the audit record is not diluted with extra free-text fields such as message or severity.

Write audit entries in the same transaction as the Expense Report state change. The table is
append-only: PostgreSQL triggers reject UPDATE and DELETE, while application code exposes only insert
and select behavior.

## Alternatives Considered

- Keep the legacy nullable `details` field: Rejected because it makes the schema less fixed and can
  invite receipt, payment, or other sensitive values into audit records.
- Enforce append-only only in the service layer: Rejected because direct SQL writes could still
  mutate historical audit records.
- Store audit dimensions inside JSON: Rejected because first-class columns give stronger nullability,
  enum, foreign-key, and query guarantees.

## Consequences

POSITIVE: Every stored audit entry has the same complete set of required fields.

POSITIVE: Audit rows are queryable per Expense Report through tenant-scoped relational columns.

POSITIVE: Database triggers protect audit history even outside normal application code paths.

NEGATIVE: Schema changes require coordinated Drizzle migration and TypeScript schema updates.

NEGATIVE: Failed attempts that roll back the state change do not leave a committed audit row in this
model.

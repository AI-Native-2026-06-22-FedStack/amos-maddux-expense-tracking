# ADR-0009: Case Queue DynamoDB Read Model

## Status

Accepted.

## Context

The Case Queue dashboard currently reads from the PostgreSQL `expense_report` table, which
remains the source of truth for Expense Reports. The dashboard needs a denormalized
DynamoDB read model that can be refreshed alongside PostgreSQL writes and served from
DynamoDB Local in integration tests.

The dashboard performs these reads:

1. Tenant cases by stage.
   - Shape: list Expense Reports for one authenticated tenant grouped or filtered by
     `current_stage`.
   - Consistency: eventually consistent for normal dashboard list reads because a brief
     delay between the PostgreSQL write and the denormalized read model is acceptable.
   - Strong consistency: required only for read-your-own-write checks, such as confirming
     a just-updated case's stage immediately after a write has updated this read model.

2. Single case by id with tenant and stage context.
   - Shape: fetch one Expense Report row after the caller has tenant and stage context
     from the dashboard list. The dashboard does not need a bare id-only lookup.
   - Consistency: eventually consistent for normal row expansion or navigation from the
     dashboard because the list itself can tolerate brief staleness.
   - Strong consistency: required for read-your-own-write checks that verify the exact
     case immediately after an upsert to this read model.

3. Tenant overdue cases by due date.
   - Shape: list Expense Reports for one authenticated tenant ordered and filtered by
     `due_date`, with overdue status computed when the rollup item is written.
   - Consistency: eventually consistent because the dashboard's overdue list can tolerate
     a brief lag after writes or clock-boundary changes.

## Decision

Use one DynamoDB table with a string partition key `pk`, a string sort key `sk`, and one
global secondary index named `GSI1` with string keys `gsi1pk` and `gsi1sk`.

The table stores one denormalized rollup item per Expense Report:

- `pk`: `TENANT#<tenantId>`
- `sk`: `STAGE#<currentStage>#CASE#<caseId>`
- `gsi1pk`: `TENANT#<tenantId>`
- `gsi1sk`: `DUE#<dueDate>#STAGE#<currentStage>#CASE#<caseId>`
- Attributes: `caseId`, `tenantId`, `stage`, `dueDate`, `overdue`

The base table serves the stage dimension directly:

- Tenant cases by stage: `Query` the base table with
  `pk = TENANT#<tenantId>` and `begins_with(sk, STAGE#<stage>#)`. To list all stages for
  the tenant, query `pk = TENANT#<tenantId>` and group results by `stage` in memory.
- Single case by id with tenant and stage context: `Query` the base table with
  `pk = TENANT#<tenantId>` and `sk = STAGE#<stage>#CASE#<caseId>`.

The GSI serves the due-date dimension the base table cannot efficiently serve:

- Tenant overdue cases by due date: `Query` `GSI1` with `gsi1pk = TENANT#<tenantId>` and
  a bounded `gsi1sk` range from `DUE#0000-00-00` through the target date prefix.

The tenant id always comes from `AuthenticatedRequestContext.tenantId`; callers must not
source tenant scope from a request body or query parameter. Every access pattern is a
single DynamoDB `Query`. The design intentionally omits a second GSI for id-only lookups
because the dashboard already has tenant and stage context.

## Alternatives Considered

- Put due date in the base sort key and use the GSI for stage: This also satisfies the
  reads, but stage is the dashboard's primary list grouping and row-click context, so the
  base table should serve that path directly.
- Add an id-only GSI: Rejected because the dashboard does not perform bare id-only reads,
  and adding an index would create unnecessary write cost and schema surface.
- Use `Scan` with filters for overdue or single-case reads: Rejected because the read
  model exists specifically to provide key-addressable dashboard access patterns.

## Consequences

POSITIVE: The dashboard can read tenant-scoped stage lists, tenant/stage/id cases, and
overdue-by-date lists with single `Query` operations.
POSITIVE: Only one GSI is needed, and it is reserved for the due-date access pattern not
served by the base key.
NEGATIVE: Stage transitions must rewrite the item's sort key, so writers must upsert the
new item and remove or overwrite any old-stage item when they know the previous stage.
NEGATIVE: The read model is eventually consistent for normal dashboard reads and must be
kept in sync from the PostgreSQL source of truth.

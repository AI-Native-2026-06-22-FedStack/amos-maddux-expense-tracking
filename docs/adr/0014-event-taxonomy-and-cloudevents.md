# ADR-0014: Event Taxonomy and CloudEvents Envelope

## Status

Accepted

## Context

ExpenseFlow needs a validated domain-event contract for facts published from the Expense Report stage machine. Event names must describe completed business facts and must not encode commands, handlers, or requests for another service to act.

## Decision

ExpenseFlow will start its event taxonomy with `com.expenseflow.expense-report.stage-transitioned.v1`.

- `com.expenseflow.expense-report.stage-transitioned.v1`: Fact because an Expense Report has already moved from one stage to another; it does not name or require any consumer action.

This event uses a CloudEvents 1.0 envelope validated with Zod at the boundary. The envelope requires `id`, `source`, `specversion`, and `type`, and uses `time`, `subject`, and `datacontenttype` for the stage-transition event. The domain payload stays under `data` with the Expense Report id, tenant id from the JWT claim, from-stage, to-stage, schema version, and originating request correlation id.

The first schema lives in `apps/api/src/events/` because the event depends on API-owned Expense Report stage vocabulary and there is not yet a separate cross-service event-schema package contract.

## Alternatives Considered

- Command-shaped event names: Rejected names such as `expense.validate`, `notification.send`, and `expense-report.transition` because they instruct a handler or request future work instead of stating a completed fact.
- Shared schema package: Deferred `packages/shared-schemas` because this first event is owned by the API boundary and moving it to a shared package would create a broader contract before there is more than one event consumer need.

## Consequences

POSITIVE: Consumers can subscribe to a stable past-fact event without the producer knowing which teams or workflows will use it.
POSITIVE: CloudEvents 1.0 required attributes are enforced at the boundary, so malformed envelopes fail before publication or consumption.
NEGATIVE: The API owns the first event schema location, so a future multi-service event catalog may require moving or re-exporting the schema.
NEGATIVE: The taxonomy starts with one event, so new events must continue applying the fact-not-command coupling test before they are added.

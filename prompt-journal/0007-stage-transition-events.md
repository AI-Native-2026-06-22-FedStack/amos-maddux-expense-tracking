# 0007 — Stage Transition Events

- **_Asked:_** Publish the ExpenseReportStageTransitioned CloudEvent after successful stage transitions through SNS to an SQS queue with a DLQ.

- **_Produced:_** Added an SNS-backed stage-transition event publisher that builds and validates the CloudEvents envelope after the transition persistence call succeeds. LocalStack compose init now creates the `expenseflow-stage-events` SNS topic, `expenseflow-stage-projection` standard SQS queue, and `expenseflow-stage-projection-dlq`, subscribes the queue to the topic with raw message delivery, and attaches a redrive policy with `maxReceiveCount = 3`.

- **_Accepted / Rejected:_** ACCEPTED: Use a standard SQS queue for the fan-out buffer. REJECTED: Use a FIFO queue before any consumer has a strict per-Expense Report ordering requirement.

- **_Why:_** Standard SQS is at-least-once and unordered, so consumers must be idempotent and tolerate stale or out-of-order stage-transition facts. That fits this event because consumers can deduplicate by CloudEvents `id` or a domain key and can compare against current Expense Report state when ordering matters. FIFO can be revisited later with `MessageGroupId = expenseReportId` if a real consumer proves it needs per-report ordering, but starting standard avoids unnecessary throughput and operational constraints.

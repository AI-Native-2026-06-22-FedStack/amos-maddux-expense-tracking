# ADR-0021: Lambda for Issue-Payment Workload

## Status

Accepted.

## Context

ExpenseFlow already runs the Core Case Service and GL-coding engine as ECS
Fargate services. That remains appropriate for the always-on HTTP API and
private compute service because they need steady readiness, warm database or
service dependencies, and predictable availability behind the ALB.

The Issue-Payment stub runs only during the Paid to Reconciled settlement path.
It is a short command-forwarding workload, has no direct database ownership, and
can scale to zero between settlement events.

## Decision

Move the Issue-Payment stub to a Node 24 Lambda on ARM64 behind an API Gateway
HTTP API proxy route:

`POST /v1/expense-reports/{expenseReportId}/issue-payment`

The Lambda forwards the command to the Core Case Service advance endpoint and
does not write ExpenseFlow persistence directly. Initialization creates reusable
configuration, the Powertools logger, and the Core Case Service client outside
the handler. Each invocation reads all request data from the API Gateway event
and carries the M6 `X-Correlation-Id` into structured Powertools logs.

## Criteria

- Traffic shape: Issue-Payment is low-volume and spiky, tied to settlement
  transitions rather than normal page traffic, so zero-baseline compute is a
  better fit than an idle always-on task.
- Run duration: the handler performs one short HTTP command and is comfortably
  below Lambda's 900-second maximum.
- Latency tolerance: settlement can tolerate an occasional cold start more than
  the interactive Core Case Service can.
- Cost: the workload should incur compute cost only when invoked; the Core Case
  Service keeps its Fargate baseline because it serves continuous API traffic.

## Consequences

POSITIVE: The settlement command stub has a small, independently deployable
runtime with structured, correlatable logs.

POSITIVE: The Core Case Service remains the database-owning boundary for Expense
Report stage changes.

NEGATIVE: Local floci cold-start observations are modeled and indicative only;
Module 8 must verify production latency and logging behavior in real AWS.

# ADR-0021: ECS-vs-Lambda Workload Placement

## Status

Accepted.

## Context

[ADR-0020](0020-ecs-fargate-vs-alternatives.md) selected ECS Fargate for the
long-lived ExpenseFlow backend runtime. The Core Case Service and GL-coding
engine remain appropriate for Fargate because they need steady readiness, warm
database or service dependencies, and predictable availability behind the ALB.

Module 7 adds a second placement decision: the Issue-Payment stub from the Paid
to Reconciled settlement path can run independently from the always-on Core Case
Service. It is a short command-forwarding workload, has no direct database
ownership, and can scale to zero between settlement events.

The decision needs to be per workload. The Core Case Service remains the
database-owning HTTP API for Expense Reports. The Issue-Payment Lambda is a
command-forwarding stub that receives an API Gateway HTTP API proxy event and
calls the Core Case Service advance endpoint; it does not write the database.

## Decision

Move the Issue-Payment stub to a Node 24 ARM64 Lambda behind one API Gateway
HTTP API proxy route:

`POST /v1/expense-reports/{expenseReportId}/issue-payment`

Keep the Core Case Service on ECS Fargate behind the ALB `/v1/*` route.

The Lambda forwards the command to the Core Case Service advance endpoint and
does not write ExpenseFlow persistence directly. Initialization creates reusable
configuration, the Powertools logger, and the Core Case Service client outside
the handler. Each invocation reads all request data from the API Gateway event
and carries the M6 `X-Correlation-Id` into structured Powertools logs.

## Criteria and Measurements

| Criterion | Issue-Payment measurement | Decision impact | Core Case Service measurement | Decision impact |
| --- | --- | --- | --- | --- |
| Traffic shape | The committed HTTP API has one Issue-Payment route, and the local floci route verification exercised two synthetic settlement invokes rather than continuous request traffic. | Fits Lambda because the workload is low-volume and bursty around settlement transitions. | floci ECS evidence shows `desiredCount=1`, `runningCount=1`, `pendingCount=0` for the Core Case Service, and the ALB listener forwards `/v1/*` traffic to it. | Fits Fargate because the service has an always-on task and public API routing. |
| Run duration | The live floci route invocations returned handler responses in under one second on the validation path, and the handler does one bounded command-forwarding HTTP call with a configured Lambda timeout of 30 seconds, far below Lambda's 900-second maximum. | Fits Lambda because the work is short and bounded. | The Core Case Service is not a single bounded job; it owns Express routing, auth, idempotency, database access, Redis, service calls, readiness, and repeated `/v1` requests. | Fits Fargate because it is a long-running service process, not an invocation-sized task. |
| Latency tolerance | The first local floci invoke after code update modeled container launch plus handler initialization at about 0.4 seconds from container launch log to `issuePayment.initialized`; this is indicative only because floci does not reproduce real Lambda cold starts. The settlement command can tolerate that occasional start-up cost. | Fits Lambda because cold start is acceptable for this non-interactive settlement stub. | The Core Case Service is the interactive API surface used by the web app and ALB; its task definition includes `/ready` health checks every 15 seconds with a 30-second start period so traffic only routes to a warm service. | Fits Fargate because predictable readiness and warm dependencies matter for the main API. |
| Cost | The Lambda has no configured desired task count and floci launched/reused a runtime container only when the two route requests arrived; the warm-pool idle eviction was 300 seconds. | Fits Lambda because zero-baseline compute is the cheaper shape for sparse settlement invokes. | The Core Case Service task definition reserves 512 CPU units and 1024 MiB memory with `desiredCount=1`. | Fits Fargate because the service intentionally pays for a continuous baseline to keep the API available. |

## Consequences

POSITIVE: The Issue-Payment workload scales down between settlement events while
keeping structured Powertools logs and the M6 correlation ID.

POSITIVE: The Core Case Service stays the Expense Report persistence boundary
and keeps its Fargate readiness, ALB routing, database, Redis, and service
dependencies warm.

POSITIVE: The split is measurable: route count, observed local invokes, Lambda
timeout, ECS desired/running counts, health-check configuration, and reserved
Fargate task size are all recorded in version-controlled evidence.

POSITIVE: The settlement command stub has a small, independently deployable
runtime with structured, correlatable logs.

NEGATIVE: The Lambda adds a second runtime and API Gateway integration to
operate.

NEGATIVE: floci cold-start measurements are modeled locally and indicative
only. They must not be treated as production latency numbers; Module 8 must
verify production latency and logging behavior in real AWS.

## Sources

- `evidence/issue-payment-lambda-floci.md`
- `evidence/ecs-alb-floci.md`
- `lambda/issue-payment/floci/function.json`
- `lambda/issue-payment/floci/http-api-route.json`
- `ecs/core-case-service.json`
- `ecs/core-case-task-definition.json`

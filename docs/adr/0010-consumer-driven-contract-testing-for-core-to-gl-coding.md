# ADR-0010: Consumer-Driven Contract Testing for Core to GL Coding

## Status

Accepted

## Context

ExpenseFlow has a Core Case Service in `apps/api` that submits Expense Reports and calls the
FastAPI Domain Compute service in `services/compute` for GL coding decisions through `/v1/coding`.
The two services are separate bounded contexts, but ExpenseFlow owns both sides of this integration.

Because the consumer and provider are both internal, the most important breakage to prevent is a
change that violates Core's real submit-time usage of the GL-coding API. A provider-first contract
could document more behavior than Core depends on, while broad end-to-end tests would be slower and
less precise about which request and response shapes are required.

## Decision

The Core to GL-coding contract is consumer-driven. The Node Core Case Service is the Pact consumer,
and the FastAPI Domain Compute GL-coding API is the provider for `/v1/coding`.

Core-owned Pact interactions must describe the request and response shapes Core actually uses when
submitting an Expense Report for GL coding. Provider verification must prove that Compute still
satisfies those interactions. Since ExpenseFlow owns both sides, the consumer's real usage is exactly
what must not break.

Capstone integrations are covered as follows:

- **Pact-tested:** Core to GL-coding Compute HTTP API for Expense Report submit-time coding.
- **Not Pact-tested:** Core to AWS Secrets Manager, Core to DynamoDB/LocalStack, Core to Redis, Core
  to PostgreSQL, public OpenAPI clients, and Compute to its GL coding datastore.

AWS Secrets Manager is deliberately not Pact-tested because ExpenseFlow does not own the provider
API. Its alternative check is a LocalStack-backed integration test plus strict runtime secret schema
validation using synthetic secrets.

Other non-Pact integrations use the check that best matches the dependency boundary: container or
emulator integration tests for PostgreSQL, DynamoDB Local, and Redis; and OpenAPI contract tests for the public API shape.

## Alternatives Considered

- **Provider-driven contract for GL coding:** Rejected because it would center Compute's advertised
  surface instead of Core's real submit-time usage, which is the behavior ExpenseFlow most needs to
  preserve.
- **Pact for third-party APIs:** Rejected because Pact is strongest when both sides can publish and
  verify expectations. ExpenseFlow does not control AWS Secrets Manager, DynamoDB, Redis, or
  PostgreSQL provider behavior.
- **Only end-to-end tests:** Rejected because they are useful for workflow confidence but less
  precise than consumer-driven contracts for identifying a breaking Core to Compute API change.

## Consequences

POSITIVE: The GL-coding contract protects the request and response behavior Core actually depends on
during Expense Report submission.

POSITIVE: Owning both sides lets ExpenseFlow update Core's Pact expectations and Compute's provider
verification together when the intended usage changes.

POSITIVE: Third-party and infrastructure dependencies are checked with realistic emulators,
containers, schema validation, or OpenAPI tests instead of unsuitable Pact contracts.

NEGATIVE: Consumer expectations must be kept current when Core's GL-coding usage changes.

NEGATIVE: Provider verification adds another release gate for Compute changes that affect
`/v1/coding`.

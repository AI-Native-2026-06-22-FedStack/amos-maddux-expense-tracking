# ADR-0007: Service Boundaries and Anti-Shared-DB Rule

## Status

Accepted.

## Context

ExpenseFlow is splitting responsibilities between the Node Core Case Service in
`apps/api` and the FastAPI Domain Compute service in `services/compute`. The
Node service owns the Expense Report Case, identity and auth, authentication,
and JWT issuance. The compute service owns GL coding and verifies Node-issued
tokens.

Without an explicit boundary, a schema change in one service could silently
break the other through direct database reads, writes, or joins. ExpenseFlow
needs each service to evolve its schema behind an API contract, with clear
versioning for cross-context calls.

## Decision

ExpenseFlow will keep two coherent bounded contexts:

- **Node Core Case Service:** Owns Expense Report Case data, identity/auth data,
  authentication, and JWT issuance in the Node Core PostgreSQL datastore.
- **FastAPI Domain Compute Service:** Owns GL coding in a separate
  compute-owned datastore and verifies Node-issued JWTs.

Cross-service data access must happen through the owning service API. Direct
cross-boundary database reads and writes are forbidden. Scripts, tests,
migrations, and operational repair must not bypass the owning service boundary.

Node-to-Compute calls remain synchronous over the Compute HTTP API this sprint.
Compute verifies bearer tokens using Node-issued JWT trust material and must not
query the Node Core PostgreSQL datastore for identity, tenant, or Expense Report
Case data.

A future `/v2` API can coexist with `/v1`. Cross-context calls must target an
explicit API version, and retired versions must follow the deprecation lifetime
and deprecation headers documented in ADR-0006.

## Alternatives Considered

- **Shared database with service-owned table conventions:** Rejected because it
  still permits accidental cross-boundary reads, writes, joins, and repair
  scripts that can make one service depend on another service's private schema.
- **Service per table:** Rejected because ExpenseFlow needs coherent bounded
  contexts. Expense Report Case tables belong together with the Node workflow,
  identity/auth tables belong with authentication and JWT issuance, and GL coding
  belongs with domain compute.


## Consequences

POSITIVE: Schema changes can be managed inside the owning service without
silently breaking another service through a shared database dependency.
POSITIVE: The boundary map gives engineers a discoverable source of truth for
which service owns Expense Report Case, identity/auth, and GL coding data.
NEGATIVE: Cross-context features require API design and versioning instead of
quick direct database joins.
NEGATIVE: Separate datastores require extra operational discipline for
migrations, tenant isolation, observability, and local development.

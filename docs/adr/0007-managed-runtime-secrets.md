# ADR-0007: Managed Runtime Secrets

## Status

Accepted.

## Context

ExpenseFlow needs the TypeScript Express API to use a database password and
RS256 JWT signing keys without placing real secret values in committed files,
logs, tests, fixtures, or example configuration. A committed database password
or private signing key would be difficult to rotate cleanly and could let a
source-code reader impersonate the service or connect to protected data stores.

The service also needs deterministic startup behavior. Missing or malformed
secret configuration should stop the API during boot, before it can accept
requests, instead of failing later on the first database connection or token
operation. At the same time, rotated secrets need to be picked up without a
redeploy.

Local development and test environments use LocalStack to mock AWS services, so
the same AWS Secrets Manager access pattern can be exercised without connecting
to real AWS. For this capstone, LocalStack must be pinned to
`localstack/localstack:4.14.0`; newer LocalStack images require a
`LOCALSTACK_AUTH_TOKEN` and no longer provide the same free local path.

## Decision

ExpenseFlow will store runtime secret values for the TypeScript Express API in
AWS Secrets Manager. Local and test environments use LocalStack 4.14.0 as the
Secrets Manager endpoint.

The database password and RS256 JWT signing keys are addressed by SecretId. The
example environment file contains SecretId references and non-secret
configuration only; it must not contain a database password, private key, public
key, or local key-file path. The database URL is configured without an embedded
password, and the runtime composes the final connection string from the managed
password secret.

The API validates remaining non-secret environment variables at startup with a
strict zod schema. Required values include the LocalStack `AWS_ENDPOINT`, AWS
region, database password SecretId, JWT signing keys SecretId, passwordless
database URL, Redis URL, JWT metadata, and rate-limit settings.

The API preloads the required secrets during boot before binding the HTTP
server. Missing SecretIds, empty secret values, malformed JWT signing key JSON,
or invalid PEM material fail startup immediately. This fail-fast behavior keeps
bad deployments from accepting traffic in a partially configured state.

Loaded secrets are cached in process memory. The cache refreshes every five
minutes so rotated secrets are picked up quickly without a redeploy, while
avoiding request-by-request Secrets Manager calls that would add latency and
hammer Secrets Manager with unnecessary traffic.

For deployed environments, ExpenseFlow should use an IAM task role scoped to
only the exact database password and JWT signing key SecretIds required by the
API. This least-privilege access model is previewed by this ADR but is not
shipped in this sprint.

## Alternatives Considered

- **Committed or env-pasted secret values:** Rejected because database
  passwords and JWT signing keys would spread into source control, examples,
  logs, shell history, and local copies, making exposure and rotation harder to
  control.
- **Runtime key files checked into or distributed beside the service:** Rejected
  because file-based key loading keeps secret distribution outside the managed
  store and makes rotation dependent on filesystem updates or redeploys.
- **Fetching secrets from Secrets Manager on every request:** Rejected because
  it increases request latency, couples request availability to Secrets Manager
  availability, and creates unnecessary read volume. A five-minute cache refresh
  gives timely rotation pickup without hammering Secrets Manager.

## Consequences

POSITIVE: Real database passwords and RS256 signing keys are removed from
committed runtime files and examples.

POSITIVE: Invalid secret configuration fails at boot before the API accepts
traffic.

POSITIVE: Rotated secrets are picked up without redeploying the API, usually
within five minutes.

POSITIVE: The documented IAM task role model gives deployed environments a
least-privilege target scoped to specific managed secrets.

NEGATIVE: Local development now requires LocalStack secret setup before the API
can boot successfully.

NEGATIVE: Secret payload shapes are part of the runtime contract and must be
validated and maintained with the same care as other service configuration.

NEGATIVE: The IAM task role and exact managed policy are still future deployment
work, so this sprint documents the least-privilege model without shipping it.

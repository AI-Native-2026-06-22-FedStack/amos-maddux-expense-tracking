# ADR-0005: API Versioning and Deprecation Policy

## Status

Accepted

## Context

ExpenseFlow exposes secured Expense Report and auth routes through a published OpenAPI contract. API
clients need a stable way to identify the contract they are using, plan migrations, and distinguish
breaking changes from compatible additions. The API also needs a predictable deprecation lifetime so
legacy routes can keep working long enough for clients to move to their replacement.

## Decision

Use URL versioning as the primary API versioning policy. Canonical API routes are mounted under the
version prefix, beginning with `/v1`, and the published OpenAPI document reports `/v1` as the base
path for versioned routes.

Keep deprecated legacy routes functional during a 90-calendar-day deprecation lifetime that starts on
the deprecation date. When a route is actively deprecated, announce that at runtime with the
`Deprecation` response header, the `Sunset` response header, and a `Link` response header using
`rel="successor-version"` to point to the replacement route.

Classify API compatibility as follows:

- Renaming a field is breaking.
- Removing a route is breaking.
- Adding an optional field is non-breaking.

## Alternatives Considered

- Header-based versioning: Rejected because URL versioning is easier for clients to see, easier for
  Express routing to enforce, and clearer in generated OpenAPI contracts and published docs.
- Header-only deprecation without URL versioning: Rejected because lifecycle headers are useful for
  migration notices but do not give clients a stable contract namespace.

## Consequences

POSITIVE: Clients can target an explicit API version and read the same base path in the published
OpenAPI contract.

POSITIVE: Deprecated routes have a documented migration window before removal.

POSITIVE: Compatibility classification gives reviewers a shared standard for deciding whether a
change requires a new version or deprecation period.

NEGATIVE: Temporary legacy routes must be maintained, tested, and monitored during the deprecation
lifetime.

NEGATIVE: API changes require compatibility review before release instead of relying only on local
implementation judgment.

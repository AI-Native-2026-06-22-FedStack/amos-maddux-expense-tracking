# ADR-0005: Auth and Session Model

## Status

Accepted

## Context

ExpenseFlow needs an authentication model for users across tenants. The shipped surface includes
registration, password login, MFA completion, RS256 token issuing, Passport JWT verification, and
JWT-protected Expense Report creation and reads. The persistence model must support the existing
roles of Finance Admin, Department Manager, and Employee, plus an ExpenseFlow Platform Admin role
for platform operations.

Auth data has different confidentiality and lifecycle requirements than profile data. Password
hashes, refresh tokens, and TOTP secrets should not live directly on the profile row, and every auth
table must carry a tenant boundary.

## Decision

Use stateless access tokens with persisted, revocable refresh tokens instead of server-side sessions.
Access tokens will be verified without a session lookup, while refresh token records provide a
server-side revocation point and audit-friendly lifecycle.

Use RS256 for JWT signing rather than HS256. RS256 allows services that only verify tokens to hold
public keys while the private signing key remains isolated to the issuer. This reduces shared-secret
spread and makes key rotation cleaner.

Store credential and MFA data outside the user profile. The user profile table contains account
identity fields and role assignment. The credential table stores only a password hash. The MFA
enrollment table stores an encrypted TOTP secret and key identifier, establishing the schema boundary
for protected-at-rest secret storage without introducing crypto implementation in this task.

Require `tenant_id` on every auth table. Tenant-scoped unique constraints and foreign keys keep auth
records tied to the same tenant and make tenant isolation explicit in the database model.

Expose the implemented auth flow through public HTTP endpoints for registration, password login, and
MFA completion. The service layer remains framework-independent, while controllers translate service
results to HTTP and Problem+JSON responses. Expense Report routes derive tenant identity from the
verified JWT context rather than accepting tenant identifiers from clients.

## Consequences

POSITIVE: Stateless access tokens avoid a database lookup on every authenticated request and keep
API verification straightforward for services that have the public key.

POSITIVE: Persisted refresh tokens give ExpenseFlow a revocation mechanism without requiring
server-side sessions for every request.

POSITIVE: Separating credential and MFA secrets from profile rows reduces accidental exposure in
profile queries and keeps sensitive data access paths narrower.

POSITIVE: Tenant-scoped auth tables make tenant isolation visible in constraints, indexes, and data
access patterns.

NEGATIVE: RS256 introduces key-management complexity, including private key protection, public key
distribution, and rotation procedures.

NEGATIVE: Stateless access tokens are harder to revoke immediately than server-side sessions because
issued access tokens remain valid until expiry unless additional revocation infrastructure is added.

NEGATIVE: Separating profile, credential, MFA, and token data requires more joins and repository
coordination than embedding all auth fields on one user row.

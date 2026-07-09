# Authentication Regression Test Evidence

## Scope

The authentication attack regression suite exercises the real ExpenseFlow Express app, Passport JWT
middleware, RS256 token validation, auth service, and PostgreSQL integration-test database.

Test suite: `apps/api/test/auth/auth.attacks.test.ts`

## Attack Coverage

| Scenario                                       | Expected result                                    | Observed assertion                                                                    |
| ---------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Valid RS256 bearer token                       | Protected Expense Report creation succeeds         | HTTP 201 and persisted tenant/user come from the JWT                                  |
| Missing bearer token                           | Request is rejected before controller/service work | HTTP 401 and no Expense Report row is created                                         |
| Malformed bearer token                         | Request is rejected before controller/service work | HTTP 401 and no Expense Report row is created                                         |
| Expired RS256 token                            | Request is rejected before controller/service work | HTTP 401 and no Expense Report row is created                                         |
| Wrong issuer token                             | Request is rejected before controller/service work | HTTP 401 and no Expense Report row is created                                         |
| Wrong audience token                           | Request is rejected before controller/service work | HTTP 401 and no Expense Report row is created                                         |
| Forged `alg=none` token with elevated role     | Request is rejected before controller/service work | HTTP 401 and no Expense Report row is created                                         |
| RS256 token signed by the wrong private key    | Request is rejected before controller/service work | HTTP 401 and no Expense Report row is created                                         |
| Client-supplied tenant differs from JWT tenant | JWT tenant wins                                    | Expense Report is created only for the authenticated tenant                           |
| Authenticated Expense Report read              | JWT tenant can read its own report                 | HTTP 200 when bearer token tenant matches the report tenant                           |
| Unauthenticated Expense Report read            | Request is rejected before controller/service work | HTTP 401 for `GET /expense-reports/:id` without a bearer token                        |
| Cross-tenant Expense Report read               | Other tenant cannot read the report                | HTTP 404 when bearer token tenant differs from the report tenant                      |
| Client-supplied read tenant                    | Query tenant cannot override JWT tenant            | Query `tenantId` is ignored and the JWT tenant is used                                |
| HTTP registration/login/MFA                    | Implemented auth flow is reachable over HTTP       | `/auth/register`, `/auth/login`, and `/auth/mfa` complete the synthetic flow          |
| Unknown user login                             | Generic failure                                    | Response matches wrong-password failure and has no token fields                       |
| Wrong password login                           | Generic failure                                    | Response matches unknown-user failure and has no token fields                         |
| Wrong TOTP code                                | Authentication fails                               | Unauthorized result and no refresh token is persisted                                 |
| Valid password plus valid TOTP                 | Authentication succeeds                            | Access token and refresh token are returned; only the refresh-token hash is persisted |
| Replayed TOTP code                             | Authentication fails                               | Unauthorized result, no second refresh token, and `mfa_failed_replay` is audited      |
| MFA post-verification failure                  | TOTP step is not consumed                          | Synthetic later failure leaves accepted step null and persists no refresh token       |
| Auth identity migration                        | Migration applies and auth tables exist            | Fresh PostgreSQL container applies migrations and finds all identity/auth tables      |
| Seeded role catalog                            | Fixed roles exist for system tenant                | Migration verification finds the four required role names                             |

## Hardening Evidence

- Authentication outcomes write safe `auth_audit_entry` rows with event type, outcome, tenant id,
  optional user id, and generic reason category only.
- Persisted TOTP replay protection stores the last accepted TOTP time step on the MFA enrollment.
  A reused code in the same time step is rejected before token issuance.
- MFA completion looks up the authenticated user and creates token material before consuming the
  TOTP step; the accepted step, refresh-token hash, and success audit are persisted together.
- Migration verification uses a fresh PostgreSQL container and the real Drizzle migrations. It
  verifies `user`, `credential`, `role`, `refresh_token`, and `mfa_enrollment`; `tenant_id not null`;
  seeded role names; `credential.password_hash`; absence of plaintext password columns; and the
  protected MFA secret storage boundary.
- HTTP auth route tests exercise the real Express app and auth service for registration, password
  login, and MFA completion.

## Security Notes

- Tests do not mock or bypass the Passport JWT verifier for protected route checks.
- Tests use synthetic identifiers and generated/in-memory key material only.
- Tests do not log or snapshot passwords, password hashes, JWTs, refresh tokens, private keys, or
  TOTP secrets.

# ADR-0013: Data-Fetching Pattern

## Status

Accepted.

## Context

ExpenseFlow's React app is adding routed screens that read and mutate tenant-scoped server data.
The app already keeps authentication session state in `AuthSessionProvider`, and ADR-0012 reserves
server state for a dedicated data-fetching layer rather than a generic client store.

React Router can fetch data through loaders and actions, while TanStack Query can own cached server
state, retries, invalidation, and mutation lifecycles. Using both for API data would create two
caches and two invalidation paths for the same Expense Report data.

The Core Case Service also depends on every SPA request carrying the current bearer token and the
Module 3 `X-Correlation-Id` contract. Problem+JSON responses need to become renderable UI errors
instead of raw response bodies.

## Decision

Use TanStack Query as the owner of server state. Expense Report queues, approval queues, detail
reads, and mutations will use TanStack Query queries and mutations for caching, loading, error,
empty, and invalidation states.

Use React Router for navigation only. Route definitions may choose layouts, guards, and error
elements, but Router loaders and actions must not fetch API data because they would create a second
server-state cache.

Route every SPA API call through the single fetch-based API client in `apps/web/src/api/client.ts`.
The client attaches `Authorization: Bearer <token>` when a session exists, attaches
`X-Correlation-Id` on every request, maps non-ok RFC 9457 Problem+JSON responses to typed UI errors,
and never returns raw Problem JSON.

When an authenticated request receives 401, the client asks the auth session layer to refresh once
and retries the original request once. Concurrent 401 responses share one in-flight refresh. If
refresh fails, the auth session is cleared so the user returns to sign-in. If the retry still returns
401, the typed error is surfaced without another refresh attempt.

## Alternatives Considered

- **React Router loaders/actions for API data:** Rejected because they would add a second cache and
  invalidation model beside TanStack Query.
- **Ad hoc fetch calls per screen:** Rejected because auth headers, correlation IDs, refresh, and
  Problem+JSON mapping would be easy to forget or implement inconsistently.
- **Axios:** Rejected because ExpenseFlow's workbook rule requires `fetch` for the SPA API client.
- **Refresh per failed request:** Rejected because concurrent expired-token responses could stampede
  the auth endpoint.

## Consequences

POSITIVE: Server-state ownership is clear: TanStack Query owns data, while Router owns navigation.

POSITIVE: Auth, correlation, refresh, and error mapping are centralized in one fetch client.

POSITIVE: Concurrent 401 responses avoid refresh stampedes and refresh retries are capped.

NEGATIVE: Screens must use TanStack Query hooks rather than Router loaders for API reads.

NEGATIVE: Auth-session refresh must remain available to the API client adapter when authenticated
screens are mounted.

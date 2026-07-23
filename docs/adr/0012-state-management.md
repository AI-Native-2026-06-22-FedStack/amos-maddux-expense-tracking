# ADR-0012: State Management

## Status

Accepted.

## Context

ExpenseFlow's React app now has several kinds of client state: the authenticated session, sign-in and
MFA draft inputs, the six-stage Expense Report stepper, and future cross-screen list filters. The app
needs a deliberate state-management default before adding data fetching and more routed screens.

Adding a global client store too early would create another dependency, another mutation surface, and
another place where tenant-scoped identity or workflow state could drift from the API. Most current
state is either local to one screen, shared by nearby components, or derived from props.

## Decision

Use React built-ins by default: `useState`, `useReducer`, context, and custom hooks.

Local draft UI state stays local. The sign-in form's tenant ID, email, password, and MFA code remain
component state because no distant component needs them.

Shared-nearby state uses context and reducers. The auth session is shared through
`AuthSessionProvider` and `useAuthSession` because route guards, screens, and future API clients need
one identity source. Its transitions are explicit reducer events rather than global-store actions.

Derived UI state uses custom hooks. The stage stepper is derived from an Expense Report's current
stage and hold flag through `useStageStepper`; it does not need a store because it has no independent
client-owned lifecycle.

Server state is deferred to the data-fetching layer. Expense Reports, case queue rollups, and other
tenant-scoped API data should be cached and invalidated by the future query/data layer rather than
copied into a generic client store.

A global store such as Zustand or Redux is allowed only when an ADR can name specific client-owned
state that distant components genuinely share, cannot be kept near its users, and is not server state.
A future cross-screen filter may clear that bar if multiple distant routes must read and update the
same unsaved filter model independent of URL/query-cache state.

## Alternatives Considered

- **Zustand by default:** Rejected because the current state does not require a global mutation graph.
  It would add dependency and debugging cost before there is named distant shared client state.
- **Redux by default:** Rejected because its ceremony is not justified for the current local,
  reducer-backed, and derived state. It remains an option only if future workflow state needs that
  structure and the ADR names the shared client-owned data.
- **Context for everything:** Rejected because form drafts and derived stepper state should stay near
  their users. Broad context would increase unnecessary rerenders and blur ownership.
- **Duplicated local helpers:** Rejected because reusable logic such as auth/session transitions and
  stepper derivation belongs in custom hooks, not copied across screens.

## Consequences

POSITIVE: ExpenseFlow avoids premature Zustand or Redux while the app's state is still local,
nearby-shared, derived, or server-owned.

POSITIVE: The auth session has one explicit identity source without turning all UI state into global
state.

POSITIVE: Server cache ownership stays with the future data-fetching layer, where invalidation and
query lifecycles belong.

NEGATIVE: Some prop drilling or small provider boundaries may be needed before a global store is
justified.

NEGATIVE: If distant client-owned state appears later, the team must write a new ADR before adopting
a store.

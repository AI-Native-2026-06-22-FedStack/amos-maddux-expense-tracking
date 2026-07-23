# ADR-0011: Styling Strategy

## Status

Accepted.

## Context

ExpenseFlow is adding a Vite and React single-page app in `apps/web`. The wireframe in
`docs/wireframe.html` already defines semantic CSS and design tokens as custom properties, so the
frontend needs a styling approach that can preserve those tokens, keep styles scoped to components,
and avoid adding runtime styling complexity before the component library is built.

## Decision

Use CSS Modules as the primary styling strategy for `apps/web`.

Shared design tokens live once in `apps/web/src/styles/tokens.css` under `:root`. Component styles
live beside their components as `.module.css` files and consume those tokens through `var(--token)`
references.

## Alternatives Considered

- **vanilla-extract:** Considered because it offers type-safe styling and build-time CSS generation.
  Deferred because the wireframe ports directly to CSS Modules with less setup for this deliverable.
- **CSS-in-JS libraries such as styled-components or Emotion:** Rejected because they add runtime
  styling behavior and dependencies that are unnecessary for the static wireframe-derived component
  library.
- **Global CSS only:** Rejected because global component classes would be easier to collide as the
  design system grows.

## Consequences

POSITIVE: Component styles are scoped while preserving the wireframe's semantic CSS structure.

POSITIVE: Design tokens have one source of truth and can be shared by every atom, component, and
screen.

POSITIVE: The web app avoids CSS-in-JS runtime dependencies.

NEGATIVE: CSS class names are not type-checked as deeply as a vanilla-extract approach would allow.

NEGATIVE: Shared visual conventions still require discipline because CSS Modules scope classes, not
design decisions.

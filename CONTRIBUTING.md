# Contributing to ExpenseFlow

ExpenseFlow uses trunk-based development with short-lived branches. `develop` is the active integration trunk, and `main` is the protected production branch. The workflow keeps `develop` close to releasable, promotes stable changes through release or hotfix branches, and protects `main` as the production branch.

All contributions must follow the repository AI-assistant guide, [AGENTS.md](AGENTS.md), and the posture note, [docs/data-classification.md](docs/data-classification.md). Prompts, commits, branches, PRs, tests, logs, fixtures, screenshots, and documentation may include only synthetic or PUBLIC data. Real CUI, SBU, production data, payment data, bank-feed transaction data, secrets, credentials, tokens, and private identifiers must never be included.

## Branch Model

Keep branches short-lived and scoped to one Jira ticket whenever possible. Feature branches should be merged or closed within 3 working days. Release and hotfix branches should exist only for their release or incident window.

### `main`

- Description: Production branch containing the current stable version of the app.
- Accepts PRs from: `release/*` and `hotfix/*` only.
- Direct commits: Not allowed.
- Required protection: PR approval, passing required checks, and approval gate before production deployment.
- Merge trigger: Full test suite, security scanning, production deployment with approval gate, and smoke tests.
- Cadence: Review `develop` after every sprint to decide whether a release branch is ready to promote toward `main`.

### `develop`

- Description: Development and staging branch containing the most recent integrated version of the app.
- Accepts PRs from: `feature/*`, `release/*`, and `hotfix/*`.
- Required protection: PR approval and passing required checks.
- Merge trigger: Full test suite, code quality checks, linting, and at least 80% test coverage.

### `feature/*`

- Description: Sandbox branch for a new feature or scoped change.
- Branched from: `develop`.
- Merged to: `develop`.
- Naming convention: `feature/<JIRA-TICKET-ID>`, such as `feature/SCRUM-18`.
- Local prerequisite before push: Unit tests written and passing.
- Push and PR trigger: Full test suite, code quality checks, linting, and at least 80% test coverage.

### `release/*`

- Description: Pre-production branch for testing a full version and fixing release-blocking bugs before deployment.
- Branched from: `develop`.
- Merged to: `develop` and `main`.
- Naming convention: `release/<app-name>/v<major>.<minor>.<patch>`, such as `release/expenseflow/v1.0.0`.
- Pipeline: Full test suite, security audit, QA testing window, and deployment to pre-production.

### `hotfix/*`

- Description: Urgent production fix branch.
- Branched from: `main`, or from an active `release/*` branch if the issue affects an unreleased candidate.
- Merged to: `main` and `develop`.
- Naming convention: `hotfix/<app-name>/v<major>.<minor>.<patch>` or `hotfix/<JIRA-TICKET-ID>`, such as `hotfix/expenseflow/v1.0.1` or `hotfix/SCRUM-42`.
- Push and PR trigger: Targeted tests, regression suite, security check, and expedited deployment to staging.
- SLA: Review within 6 hours of PR creation. Required changes must be made within 12 hours of review.
- Escalation: If the 6-hour review window is missed, send a direct message reminder for PR review.

## Commit Messages

Use Conventional Commits with a short imperative summary:

```text
<type>: <short message>
```

Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, and `ci`.
An optional scope may be included as `<type>(<scope>): <short message>` when it adds useful context, but scopes are not required.

Examples:

```text
feat: add submitted stage validator
fix: reject cross-tenant report access
docs: document release branch rules
```

Commit cadence is one commit per meaningful change. Do not combine unrelated changes in one commit, and do not split one logical change across noisy checkpoint commits.

## Pull Requests

- Every PR must link its Jira ticket in the PR description.
- In general, create one PR per Jira ticket.
- If several Jira tickets cover the same issue, such as one ticket for framework design and another for testing that framework, one PR is acceptable if it references all related tickets.
- PRs must target the correct branch for their type: `feature/*` to `develop`, `release/*` to `develop` and `main`, and `hotfix/*` to `main` and `develop`.
- PRs must pass the required pipeline before merge.
- PRs must stay within 400 changed lines, excluding lockfiles and generated files.
- PRs over 400 changed lines require a written exception in the PR description that explains why the work cannot be split safely.
- PRs must not include real CUI/SBU data, secrets, production data, payment data, bank-feed transaction data, or private identifiers.

## Review Expectations

At least one approval is required before merge. Reviewers should confirm:

- The PR is linked to the correct Jira ticket or tickets.
- The branch name follows the required convention.
- The commit history uses Conventional Commits and separates meaningful changes.
- The changes comply with [AGENTS.md](AGENTS.md), including allowed stacks, domain vocabulary, forbidden scope, and data-handling rules.
- The changes comply with [docs/data-classification.md](docs/data-classification.md), especially the bright line that synthetic or PUBLIC data may enter prompts and real CUI/SBU data and secrets never do.
- Tests and quality gates are appropriate for the change and pass in CI.
- The PR stays within the 400-line size limit or documents an acceptable exception.

Feature and release PRs should receive initial review within 1 working day. Hotfix PRs follow the 6-hour review SLA above.

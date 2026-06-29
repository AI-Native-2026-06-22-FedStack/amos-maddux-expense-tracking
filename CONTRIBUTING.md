# Contributing to ExpenseFlow

ExpenseFlow uses trunk-based development with one protected trunk: `main`. All work starts from `main`, uses a short-lived branch, and merges back to `main` through a pull request after review and required checks pass.

All contributions must follow the repository AI-assistant guide, [AGENTS.md](AGENTS.md), and the posture note, [docs/data-classification.md](docs/data-classification.md). Prompts, commits, branches, PRs, tests, logs, fixtures, screenshots, and documentation may include only synthetic or PUBLIC data. Real CUI, SBU, production data, payment data, bank-feed transaction data, secrets, credentials, tokens, and private identifiers must never be included.

## Branch Model

Keep branches short-lived and scoped to one Jira ticket whenever possible. Branches should be merged or closed within 3 working days.

### `main`

- Description: Protected trunk containing the current stable version of the app.
- Accepts PRs from: Short-lived branches using the approved naming conventions below.
- Direct commits: Not allowed.
- Required protection: PR approval, passing required checks, and approval gate before production deployment.
- Merge trigger: Full test suite, security scanning, production deployment with approval gate, and smoke tests.

### Short-lived branches

- Branch from: `main`.
- Merge to: `main`.
- Naming convention: `<type>/<short-slug>`, such as `feat/add-approval-comment`, `fix/reject-cross-tenant-report-access`, or `docs/update-adr-template`.
- Allowed types: `feat`, `fix`, `docs`, `test`, `chore`, and `refactor`.
- Local prerequisite before push: Relevant tests written and passing.
- Push and PR trigger: Full test suite, code quality checks, linting, and at least 80% test coverage where applicable.
- Urgent production fixes: Use `fix/<short-slug>` from `main`, keep the PR focused, and request expedited review.

Use the branch type that matches the dominant Conventional Commit type for the work:

- `feat/<short-slug>`: New feature.
- `fix/<short-slug>`: Bug fix.
- `docs/<short-slug>`: Documentation-only change.
- `test/<short-slug>`: Test-only change.
- `chore/<short-slug>`: Maintenance task.
- `refactor/<short-slug>`: Behavior-preserving code change.

## Commit Messages

Use Conventional Commits with a short imperative summary:

```text
<type>: <short message>
```

Allowed types are `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `build`, and `ci`.
An optional scope may be included as `<type>(<scope>): <short message>` when it adds useful context, but scopes are not required.

Examples:

```text
feat: add multi-state allocation endpoint
fix: reject cross-tenant report access
docs: document trunk-based branch rules
```

Conventional Commit types drive future automated versioning:

- `fix:` triggers a PATCH release.
- `feat:` triggers a MINOR release.
- A `BREAKING CHANGE:` footer on any commit type triggers a MAJOR release.
- `docs:`, `test:`, `chore:`, and `refactor:` do not trigger a release, but keep the history scannable.

Commit cadence is one commit per meaningful change. Do not combine unrelated changes in one commit, and do not split one logical change across noisy checkpoint commits.

## Pull Requests

- Every PR must link its Jira ticket in the PR description.
- In general, create one PR per Jira ticket.
- If several Jira tickets cover the same issue, such as one ticket for framework design and another for testing that framework, one PR is acceptable if it references all related tickets.
- PRs must target `main` and use a short-lived source branch named with an approved type: `feat/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`, `test/<short-slug>`, `chore/<short-slug>`, or `refactor/<short-slug>`.
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

PRs should receive initial review within 1 working day. Urgent `fix/<short-slug>` PRs should receive expedited review within 6 hours when the issue affects production.

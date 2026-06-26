## Summary

<!-- Briefly describe what changed and why. -->

## Jira Ticket

<!-- Link the Jira ticket. If multiple related tickets are covered, link each one and explain why one PR is appropriate. -->

## Related ADRs

<!-- Link the relevant ADR when this PR changes an architectural decision. Write "N/A - no architectural decision changed" when no ADR is affected. -->

## Testing and Validation

<!-- List the local checks, tests, or review steps completed for this PR. -->

## Gitflow Checklist

- [ ] YES/NO: This PR links the relevant Jira ticket in the description.
- [ ] YES/NO: This PR covers one Jira ticket, or all related Jira tickets are linked and explained above.
- [ ] YES/NO: The source and target branches follow `CONTRIBUTING.md` rules: `feature/*` to `develop`, `release/*` to `develop` and `main`, or `hotfix/*` to `main` and `develop`.
- [ ] YES/NO: This PR is within 400 changed lines excluding lockfiles and generated files, or the exception is documented in the summary.
- [ ] YES/NO: Required checks are expected to pass before merge.

## AI Code-Review Checklist

- [ ] YES/NO: Tenant-scoped records and access paths prevent cross-tenant read, write, inference, search, export, and delivery.
- [ ] YES/NO: All new or changed external inputs are validated at boundaries, and unsafe input is rejected or normalized.
- [ ] YES/NO: Privileged actions and workflow state changes remain auditable without exposing controlled data.
- [ ] YES/NO: Raw receipt data, payment data, bank-feed transaction data, secrets, credentials, tokens, and private identifiers are not logged in plaintext.
- [ ] YES/NO: Architectural decision changes link the relevant ADR in the Related ADRs section, or the section states `N/A - no architectural decision changed`.

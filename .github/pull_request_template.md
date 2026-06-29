## Summary

<!-- Briefly describe what changed and why. -->

## Jira Ticket

<!-- Link the Jira ticket. If multiple related tickets are covered, link each one and explain why one PR is appropriate. -->

## Related ADRs

<!-- Link the relevant ADR when this PR changes an architectural decision. Write "N/A - no architectural decision changed" when no ADR is affected. -->

## Testing and Validation

<!-- List the local checks, tests, or review steps completed for this PR. -->

## Trunk-Based Checklist

- [ ] I confirm this PR links the relevant Jira ticket in the description.
- [ ] I confirm this PR covers one Jira ticket, or all related Jira tickets are linked and explained above.
- [ ] I confirm this PR targets `main` from a short-lived branch named with an approved type: `feat/*`, `fix/*`, `docs/*`, `test/*`, `chore/*`, or `refactor/*`.
- [ ] I confirm this PR is within 400 changed lines excluding lockfiles and generated files, or the exception is documented in the summary.
- [ ] I confirm required checks are expected to pass before merge.

## AI Code-Review Checklist

- [ ] I confirm tenant-scoped records and access paths prevent cross-tenant read, write, inference, search, export, and delivery.
- [ ] I confirm all new or changed external inputs are validated at boundaries, and unsafe input is rejected or normalized.
- [ ] I confirm privileged actions and workflow state changes remain auditable without exposing controlled data.
- [ ] I confirm raw receipt data, payment data, bank-feed transaction data, secrets, credentials, tokens, and private identifiers are not logged in plaintext.
- [ ] I confirm architectural decision changes link the relevant ADR in the Related ADRs section, or the section states `N/A - no architectural decision changed`.

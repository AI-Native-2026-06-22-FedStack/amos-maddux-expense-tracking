# ADR-0023: IaC Scanning Policy

## Status

Accepted.

## Context

ADR-0022 introduced Terraform as the source of truth for the local floci base
infrastructure. That base now controls network and IAM boundaries, so insecure
Terraform must fail before it can be applied. The gate needs to run without a
cloud account and produce downloadable evidence for review.

ADR-0019 already established that security scanners are gates, not advisory
reports. The same rule applies to infrastructure-as-code: real fixable
misconfigurations are fixed, not suppressed.

This policy supports NIST SP 800-53 RA-5 by continuously scanning infrastructure
definitions for known weakness patterns, and SI-2 by forcing timely correction
or documented remediation tracking before misconfigured infrastructure is
accepted.

## Decision

Run Checkov and Trivy config scanning over `infra/terraform/` in GitHub Actions.
Both scanners emit SARIF into `artifacts/security/`, and the workflow uploads
those files with `actions/upload-artifact` for 30 days. Either scanner reporting
a policy violation fails the job.

The seeded public-bucket probe used to prove the gate was fixed by removing the
temporary bad Terraform file before commit. The finding disposition is recorded
in `docs/security/disposition-log.md`.

One Checkov suppression is accepted for CKV2_AWS_5 on base security groups. The
network module creates and exports security groups before the ALB, ECS, and
database modules exist to consume them. The groups are not orphaned by design;
they are stable base outputs for later workload modules. This exception expires
when those workload modules attach the security groups.

## Skip-Justification Matrix

| Skip category | Allowed? | Required justification |
| --- | --- | --- |
| Fixable public exposure, missing encryption, wildcard IAM, or open private security boundary | No | Fix the Terraform. Do not suppress the finding. |
| floci emulator false positive where real AWS semantics differ | Yes, case-by-case | Inline scanner skip with a concrete floci limitation, owner, review date, compensating control, and this ADR updated with the specific check ID. |
| Externally owned resource represented as a data source | Yes, case-by-case | Inline scanner skip with the owner of the external control, why Terraform cannot manage it, and evidence that ExpenseFlow only reads it. |
| Base security groups exported before workload modules attach them (`CKV2_AWS_5`) | Yes, temporary | Inline Checkov skip must name ADR-0023 and the future consumer module. Remove the skip when ALB, ECS, or database modules attach the group. |
| Time-bound risk acceptance | Yes, exceptional only | Inline scanner skip with issue link, expiration date, compensating control, accountable owner, and ADR update naming the check ID. |
| Vague or bare suppression | No | `# checkov:skip=<id>` and `# trivy:ignore:<id>` without a written reason and ADR entry are banned. |

## Alternatives Considered

- Checkov only: Rejected because a second scanner catches different IaC rules
  and reduces blind spots in a Day-1 gate.
- Trivy only: Rejected because Checkov has strong Terraform-specific policy
  coverage and SARIF support.
- Soft-failing scanners: Rejected because advisory-only output allows insecure
  Terraform to merge.
- Keeping the deliberately bad resource with skips: Rejected because the public
  bucket was a proof fixture, not a genuine exception.

## Consequences

POSITIVE: Terraform changes get two independent IaC scans before merge.

POSITIVE: SARIF output is retained as downloadable workflow evidence.

POSITIVE: Suppressions require a concrete reason and an ADR-backed disposition,
which keeps exceptions visible instead of hiding risk in comments.

NEGATIVE: Scanner rule updates may break a previously green pull request; the
team must either fix the newly detected issue or record a real exception.

NEGATIVE: Local floci compatibility code may occasionally need documented
false-positive handling until the stack is verified in real AWS.

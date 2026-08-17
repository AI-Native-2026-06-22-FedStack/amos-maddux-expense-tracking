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
a policy violation fails the job. As the stack grew to network, IAM, data, app,
and observability modules, the gate scans the whole composed root
(`infra/terraform`), not one module at a time, so a new layer cannot introduce
an unreviewed HIGH/CRITICAL finding.

Resource tagging is enforced with a single `default_tags` block on the `aws`
provider in `infra/terraform/providers.tf` (`Name`, `Owner`, `Environment`),
not per-resource tag arguments. Every resource the provider manages, in any
module, inherits these tags automatically; a new resource added to any layer is
tagged without further action. Modules may still set a resource-level `Name`
tag where a more specific identity is useful (for example
`${var.stack_name}-alb`); AWS merges resource-level tags with provider
`default_tags` and resource-level values win on conflict, so this does not
weaken the default. Before this change, the `app` and `data` modules each
carried a local `default_tags` map merged by hand into every resource's `tags`
argument, and the `network` and `observability` modules had no tagging
convention at all; a resource added to any of those modules without also
copy-pasting the merge would have shipped untagged. Provider-level
`default_tags` removes that failure mode structurally.

The seeded public-bucket probe used to prove the gate was fixed by removing the
temporary bad Terraform file before commit. The finding disposition is recorded
in `docs/security/disposition-log.md`.

One Checkov suppression is accepted for CKV2_AWS_5 on base security groups. The
network module's four security groups (`alb`, `api_task`, `compute_task`, `db`)
are now attached to real resources in the `app` and `data` modules
(`aws_lb.security_groups`, `aws_ecs_service.network_configuration`,
`aws_rds_cluster.vpc_security_group_ids`), but Checkov's CKV2_AWS_5 dependency
graph does not resolve attachment when the consuming resource lives in a
different Terraform module than the security group, so it still reports these
as unattached. Verified 2026-08-13: removing the inline skips does not clear
the finding even though the attachments exist, confirming this is a scanner
graph limitation and not a stale exception. The exception remains until Checkov
resolves cross-module attachment or the security groups move into the modules
that consume them.

Two local floci suppressions are accepted on the base VPC. CKV2_AWS_11 is
accepted because floci 1.5.11 rejects EC2 `CreateFlowLogs`; production AWS must
enable VPC flow logs. CKV2_AWS_12 is accepted because floci 1.5.11 returns an
empty read for the VPC default security group; production AWS must restrict the
default security group. The owner is the platform/IaC maintainer, the review
date is 2026-09-12, and the compensating local control is explicit managed
security groups for every routed workload path.

Four suppressions are accepted on the `data` module's KMS key policies
(`rds_key`, `dynamodb_key`, and the `app` module's `logs_key`): CKV_AWS_356,
CKV_AWS_109, and CKV_AWS_111 flag `Resource: "*"` in the account-root
administrative statement. This is AWS's own documented default key policy
pattern: a key policy's `Resource` field is inherently scoped to "this key"
with no separate ARN to reference without a policy/key circular dependency, and
the principal is the AWS account root, not a wildcard identity. The
service-principal statements on the same keys are scoped to the specific
service (`rds.amazonaws.com`, `dynamodb.amazonaws.com`,
`logs.<region>.amazonaws.com`) and a fixed action list, so no unconstrained
grant exists. This exception is not time-bound; it reflects a structural
property of KMS key policies, not a local floci limitation.

The following findings are accepted stack-wide as of 2026-08-13, tracked with
owner platform/IaC maintainer and reviewed alongside floci's real-AWS
migration:

- ALB has no HTTPS listener (`CKV_AWS_2`, `CKV_AWS_378`, `CKV_AWS_103`,
  `CKV2_AWS_20`, Trivy `AWS-0054`), the ALB is internet-facing without WAF
  (`CKV2_AWS_28`, Trivy `AWS-0053`), and deletion protection is off
  (`CKV_AWS_150`) and access logging is unset (`CKV_AWS_91`). No ACM
  certificate, domain, or WAF ACL exists yet in this stack; adding one is
  ADR-worthy infrastructure work on its own, not a same-PR fix. Deletion
  protection stays off so the local floci dev loop can `terraform destroy`
  the stack; access logging needs a new S3 bucket this stack does not yet
  own. Compensating control: floci only, no real traffic. Revisit when an
  ACM certificate and domain are introduced for a non-local environment.
- The `deduction_scan` Lambda (`CKV_AWS_50`, `CKV_AWS_117`, `CKV_AWS_115`,
  `CKV_AWS_173`, `CKV_AWS_116`, `CKV_AWS_272`) deploys a placeholder ZIP
  (`lambda_deduction_scan_placeholder.zip`) with no function code yet. X-Ray
  tracing, VPC attachment, concurrency limits, environment variable KMS
  encryption, a DLQ, and code-signing are real hardening steps that belong
  with the function's actual implementation, not its placeholder scaffold.
  Revisit when the deduction-scan Lambda ships real code.
- RDS enhanced monitoring (`CKV_AWS_118`) needs a dedicated IAM monitoring
  role wired through the `iam` module; deferred as build-out work alongside
  the Lambda implementation above, not a tagging/scanning-gate change.
- Secrets Manager automatic rotation (`CKV2_AWS_57`) and an AWS Backup plan
  for the RDS cluster (`CKV2_AWS_8`) both require operational infrastructure
  (a rotation Lambda; a Backup vault and plan) this stack does not yet own.
  Deferred as follow-up infrastructure work, not suppressed silently.

## Skip-Justification Matrix

| Skip category                                                                                                                                                                                              | Allowed?                          | Required justification                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixable public exposure, missing encryption, wildcard IAM, or open private security boundary                                                                                                               | No                                | Fix the Terraform. Do not suppress the finding.                                                                                                                                                                                                                                 |
| floci emulator false positive where real AWS semantics differ                                                                                                                                              | Yes, case-by-case                 | Inline scanner skip with a concrete floci limitation, owner, review date, compensating control, and this ADR updated with the specific check ID.                                                                                                                                |
| Local floci VPC flow logs unsupported (`CKV2_AWS_11`)                                                                                                                                                      | Yes, temporary                    | Inline Checkov skip must name ADR-0023 and floci `CreateFlowLogs` rejection. Revisit by 2026-09-12 or when validating against real AWS.                                                                                                                                         |
| Local floci default security group read unsupported (`CKV2_AWS_12`)                                                                                                                                        | Yes, temporary                    | Inline Checkov skip must name ADR-0023 and floci's empty default-security-group read. Revisit by 2026-09-12 or when validating against real AWS.                                                                                                                                |
| Externally owned resource represented as a data source                                                                                                                                                     | Yes, case-by-case                 | Inline scanner skip with the owner of the external control, why Terraform cannot manage it, and evidence that ExpenseFlow only reads it.                                                                                                                                        |
| Base security groups attached only across a module boundary (`CKV2_AWS_5`)                                                                                                                                 | Yes, case-by-case                 | Inline Checkov skip must name ADR-0023 and the consumer module/resource that attaches the group. Verify the attachment actually exists before accepting; remove the skip only if Checkov starts resolving cross-module attachment or the group moves into the consuming module. |
| KMS key policy administrative statement uses `Resource: "*"` (`CKV_AWS_356`, `CKV_AWS_109`, `CKV_AWS_111`)                                                                                                 | Yes, structural                   | Inline Checkov skip must name ADR-0023 and confirm the principal is the account root (not a wildcard identity) and the statement is the standard AWS default key policy pattern, not an unconstrained grant.                                                                    |
| Missing TLS/ACM/WAF on the ALB, deletion protection, or access logging (`CKV_AWS_2`, `CKV_AWS_378`, `CKV_AWS_103`, `CKV2_AWS_20`, `CKV2_AWS_28`, `CKV_AWS_150`, `CKV_AWS_91`, Trivy `AWS-0053`/`AWS-0054`) | Yes, until real domain/cert exist | Inline skip (`#checkov:skip` and/or `#trivy:ignore`) naming ADR-0023, plus a disposition-log entry. Revisit when an ACM certificate and domain are introduced for a non-local environment.                                                                                      |
| Placeholder Lambda missing hardening (`CKV_AWS_50`, `CKV_AWS_117`, `CKV_AWS_115`, `CKV_AWS_173`, `CKV_AWS_116`, `CKV_AWS_272`)                                                                             | Yes, until real code ships        | Inline Checkov skip naming ADR-0023 and the placeholder ZIP; revisit when the function has real implementation code.                                                                                                                                                            |
| RDS/Secrets operational hardening needing new infrastructure (`CKV_AWS_118`, `CKV2_AWS_57`, `CKV2_AWS_8`)                                                                                                  | Yes, deferred build-out           | Inline Checkov skip naming ADR-0023 and the missing infrastructure (monitoring IAM role, rotation Lambda, AWS Backup plan); tracked as follow-up work, not silently dropped.                                                                                                    |
| Time-bound risk acceptance                                                                                                                                                                                 | Yes, exceptional only             | Inline scanner skip with issue link, expiration date, compensating control, accountable owner, and ADR update naming the check ID.                                                                                                                                              |
| Vague or bare suppression                                                                                                                                                                                  | No                                | `# checkov:skip=<id>` and `# trivy:ignore:<id>` without a written reason and ADR entry are banned.                                                                                                                                                                              |

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

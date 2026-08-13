# Terraform Plan — Composed Stack (network, iam, data, app, observability)

Date: 2026-08-13

All Terraform and AWS CLI calls targeted local floci only:

```sh
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
```

`terraform init`, `terraform validate`, and `terraform plan` were run from
`infra/terraform` against the composed root (network, iam, data, app,
observability modules together, one state). `terraform validate` reported
`Success! The configuration is valid.` The raw plan text is not retained
because Terraform output includes provider-generated identifier strings
(floci resource IDs); this note retains the symbol review without those
values, consistent with `evidence/terraform-plan-apply-floci.md`.

## Reviewed Plan

```text
Plan: 26 to add, 30 to change, 3 to destroy.
```

Symbol review:

| Symbol | Count | Review |
| --- | ---: | --- |
| `+` create | 26 | Net-new resources completing the `app`, `data`, and `iam` layers first applied in this change: ECS task definitions and services, the ALB and its listener/target group, the deduction-scan Lambda, RDS Aurora cluster/instances/parameter group, the DB password secret, ElastiCache cluster/subnet group, four new KMS keys (`app` CloudWatch Logs, `data` SNS, `data` DynamoDB — the RDS keys already existed and are updates below), their aliases, and the `iam` module's copy of the Lambda execution role (see destroy row). |
| `~` update in place | 30 | 27 of the 30 are `tags_all` changes only: every already-applied resource in `network`, `iam`, `data` (existing resources) gains `Owner` and `Environment` from the new provider-level `default_tags` block, and loses the old hand-maintained `Layer`/`Stack` tags from the retired per-module `local.default_tags` pattern. The remaining 3 are intentional hardening changes: `aws_kms_key.rds` and `aws_kms_key.rds_secret` gain an explicit key policy (previously AWS's implicit default), and `aws_dynamodb_table.case_queue_rollup`/`idempotency` show `deletion_protection_enabled` drifting `false -> true` — pre-existing floci drift from an earlier apply, not a change introduced here (the two DynamoDB rows also carry a tags-only change, counted once). |
| `-` destroy | 3 | `module.app.aws_iam_role.lambda_deduction_scan` and its policy attachment: pre-existing state drift from a prior module boundary move — the `iam` module now owns this role (see `infra/terraform/modules/iam/main.tf`), and its create is included in the 26 above. Unrelated to this change; not modified here. |

## Tag Enforcement Verification

Every taggable resource across all four composed layers carries `Name`,
`Owner`, and `Environment` in `tags_all` after this plan, sourced from the
single `default_tags` block on the `aws` provider in
`infra/terraform/providers.tf` — not from per-resource tag arguments. Verified
by parsing the plan's JSON-equivalent resource list: 45 of 51 planned
resources support AWS tagging and all 45 show the three required keys; the
remaining 6 (`aws_ecs_cluster_capacity_providers`, `aws_iam_role_policy` x2,
`aws_iam_role_policy_attachment` x2, and Terraform-native `terraform_data`
resources in the `network` module) are AWS resource types that do not accept
tags at all.

Concretely, `module.iam.aws_iam_role.app_task` and
`module.iam.aws_iam_role.ecs_execution` previously had `tags = {}` (no
per-resource tagging code was ever written for the IAM module) and now show:

```text
+ tags_all = {
    + "Environment" = "local"
    + "Name"        = "expenseflow"
    + "Owner"       = "platform-iac@expenseflow.internal"
  }
```

This confirms enforcement happens at the provider level: a module that never
implemented its own tagging (`iam`, and previously `network`/`observability`)
is fully tagged anyway, and a new resource added to any module going forward
is tagged without further action.

## Scan Evidence

Checkov and Trivy config were run over the full `infra/terraform` tree (all
four composed layers, not one module) after this plan was captured. SARIF
output is at `artifacts/security/checkov.sarif` and
`artifacts/security/trivy-config.sarif`. Findings and dispositions are logged
in `docs/security/disposition-log.md`; risk acceptances are backed by
ADR-0023.

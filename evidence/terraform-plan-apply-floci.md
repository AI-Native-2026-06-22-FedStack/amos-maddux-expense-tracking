# Terraform Plan/Apply floci Evidence

Date: 2026-08-12

All Terraform and AWS CLI calls targeted local floci only:

```sh
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## Reviewed Plan

The first saved plan was captured locally at
`artifacts/terraform/base-plan-reviewed.txt`.

Symbol review:

| Symbol | Count | Review |
| --- | ---: | --- |
| `+` create | 7 | VPC flow-log support resources: CloudWatch log group, IAM role, IAM role policy, KMS key, KMS alias, VPC flow log, and default security group restriction. |
| `~` update in place | 2 | Public subnets `public_a` and `public_b` changed `map_public_ip_on_launch` from `true` to `false`. |
| `-` destroy | 0 | No destroys in the first reviewed plan. |
| `-/+` replace | 0 | No replacements. No stateful destroy-before-create action was present. |

Applying the reviewed plan proved two floci 1.5.11 limitations:

- `CreateFlowLogs` is unsupported.
- The default security group read returned an empty result.

No console-only edits were made. The Terraform code was adjusted to remove those
unsupported local resources and document ADR-0023-backed Checkov exceptions for
the floci-only VPC flow log and default-security-group findings.

## Reviewed Recovery Plan

The recovery plan was captured locally at
`artifacts/terraform/base-recovery-plan-reviewed.txt`.

Symbol review:

| Symbol | Count | Review |
| --- | ---: | --- |
| `+` create | 0 | No creates. |
| `~` update in place | 0 | No updates. |
| `-` destroy | 5 | Cleanup of floci-only logging support resources created during the failed apply: CloudWatch log group, IAM role, IAM role policy, KMS alias, and KMS key. |
| `-/+` replace | 0 | No replacements. The KMS key destroy was local floci cleanup for unsupported flow-log evidence, not application state. |

The reviewed recovery plan applied successfully:

```text
Apply complete! Resources: 0 added, 0 changed, 5 destroyed.
```

## No-Drift Re-plan

The post-apply re-plan was captured locally at
`artifacts/terraform/post-apply-no-drift-plan.txt` and reported:

```text
No changes. Your infrastructure matches the configuration.
```

The base outputs after apply included the VPC, subnet tiers, security groups,
and IAM role ARNs needed by later modules.

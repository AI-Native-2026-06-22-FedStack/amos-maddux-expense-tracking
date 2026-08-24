# Blue/Green Rollback Dry-Run — floci

Date: 2026-08-17

All commands targeted local floci only:

```sh
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## Terraform Plan

The floci S3 backend bucket was missing at the start of the proof, so it was
bootstrapped with `infra/terraform/scripts/bootstrap-state-bucket.sh`.

`terraform validate` passed after the ECS blue/green configuration was added.
The dry-run plan was saved to:

```text
artifacts/terraform/blue-green-rollback-dry-run-plan.txt
```

The plan used an empty floci state file and therefore showed a full stack
create:

```text
Plan: 80 to add, 0 to change, 0 to destroy.
```

The expected blue/green release diff is present in that plan:

| Expected item                          | Plan evidence                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------- |
| Native ECS deployment controller       | `module.app.aws_ecs_service.api` includes `deployment_controller { type = ECS }` |
| No rolling-only fallback               | `deployment_configuration.strategy = "BLUE_GREEN"`                               |
| Bake window                            | `bake_time_in_minutes = "10"`                                                    |
| Primary target group                   | `module.app.aws_lb_target_group.api will be created`                             |
| Alternate target group                 | `module.app.aws_lb_target_group.api_alternate will be created`                   |
| Production listener rule               | `module.app.aws_lb_listener_rule.api_production will be created`                 |
| ECS-managed traffic flip configuration | `advanced_configuration.alternate_target_group_arn` is present                   |
| Release-health alarms with rollback    | `api_release_health` and `api_golden_signal_latency` alarms are present          |

## Listener-Switch Dry-Run

The repeatable floci proof was run with:

```sh
ROLLBACK_DRY_RUN_ID=0817b ./scripts/rollback-dry-run-floci.sh
```

The script created synthetic rollback resources only. It did not mutate the
ExpenseFlow production listener rule. Evidence landed in:

```text
artifacts/terraform/rollback-dry-run-summary.txt
artifacts/terraform/rollback-dry-run-target-groups-before.json
artifacts/terraform/rollback-dry-run-rule-serving-blue.json
artifacts/terraform/rollback-dry-run-rule-serving-green.json
artifacts/terraform/rollback-dry-run-rule-rolled-back-blue.json
```

Observed dry-run result:

| Check                            | Result                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| Two target groups exist          | `ef-bg-0817b-blue` and `ef-bg-0817b-green`                                            |
| Target groups are health-checked | Both target groups use `/health` and matcher `200`                                    |
| Traffic shift shape              | All-at-once ALB listener-rule switch                                                  |
| Cutover rehearsal                | Production rule target changed from blue target group to green target group           |
| Rollback rehearsal               | Same production rule target changed from green target group back to blue target group |

The first real rollback is therefore not the first execution of the fast path:
floci accepted the listener-rule modification and recorded the expected
blue-to-green-to-blue sequence.

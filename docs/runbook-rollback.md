# ExpenseFlow Release Rollback Runbook

Use this runbook when the `expenseflow-release-health` alarm or an ECS
post-deploy health check fails during or immediately after a Core Case Service
release.

## Dry-Run Before First Use

Before the first real rollback, and after any release-routing change, rehearse
the listener-switch path against local floci:

```bash
AWS_ENDPOINT_URL=http://localhost:4566 \
AWS_REGION=us-east-1 \
AWS_ACCESS_KEY_ID=test \
AWS_SECRET_ACCESS_KEY=test \
./scripts/rollback-dry-run-floci.sh
```

The dry-run creates synthetic blue and green target groups with `/health`
checks, switches a synthetic production listener rule from blue to green, then
switches the same rule back to blue. Review
`artifacts/terraform/rollback-dry-run-summary.txt` and the matching
`rollback-dry-run-rule-*.json` files before relying on this procedure in an
incident.

## 1. Confirm the Breach Is Real

Do not roll back on a single datapoint. Confirm the alarm stayed in `ALARM`
across its evaluation window:

```bash
RELEASE_HEALTH_ALARM="$(terraform -chdir=infra/terraform output -raw release_health_alarm_name)"

aws cloudwatch describe-alarms \
  --alarm-names "${RELEASE_HEALTH_ALARM}"
```

Check the current production health endpoint through the ALB:

```bash
ALB_URL="$(terraform -chdir=infra/terraform output -raw alb_dns_name)"
curl -fsS "http://${ALB_URL}/health"
```

If `/health` is 200 and the alarm has returned to `OK`, keep monitoring through
the bake window. If the alarm remains in `ALARM`, continue.

## 2. Locate the Failing Span

Open the X-Ray service map for the release window and compare the new traces
against the previous healthy window. Follow the slow or failing edge before
choosing rollback:

- Core Case Service inbound ALB span: elevated latency, 5xx, or saturation.
- Core Case Service to GL-coding engine span: timeout, retry growth, or 5xx.
- GL-coding engine datastore or dependency span: failure outside the release.

Decision point:

- If the degradation begins at the latest Core Case Service revision or its
  Core-to-GL-coding call shape, roll back.
- If the degradation is isolated to an external dependency, datastore, or
  GL-coding engine failure that does not track the release, rollback will not
  fix it. Keep the current release serving, investigate the span or dependency
  owner, and escalate through the release incident channel.

## 3. Fast Rollback: Switch Traffic Back to Blue

This is a listener/traffic switch, not a rebuild. Use it while the ECS
blue/green bake window is still keeping the previous blue revision alive.

Find the production listener rule and both target groups:

```bash
CLUSTER="$(terraform -chdir=infra/terraform output -raw ecs_cluster_name)"
SERVICE="$(terraform -chdir=infra/terraform output -raw api_service_name)"
PRODUCTION_RULE_ARN="$(terraform -chdir=infra/terraform output -raw api_production_listener_rule_arn)"
PRIMARY_TG_ARN="$(terraform -chdir=infra/terraform output -raw api_primary_target_group_arn)"
ALTERNATE_TG_ARN="$(terraform -chdir=infra/terraform output -raw api_alternate_target_group_arn)"

aws elbv2 describe-rules --rule-arns "${PRODUCTION_RULE_ARN}"
aws elbv2 describe-target-health --target-group-arn "${PRIMARY_TG_ARN}"
aws elbv2 describe-target-health --target-group-arn "${ALTERNATE_TG_ARN}"
```

Identify which target group still contains the last known-good blue tasks. It
must show healthy targets and must not be the failing green revision.

Switch the production rule back to that blue target group:

```bash
BLUE_TG_ARN="<last-known-good-target-group-arn>"

aws elbv2 modify-rule \
  --rule-arn "${PRODUCTION_RULE_ARN}" \
  --actions Type=forward,TargetGroupArn="${BLUE_TG_ARN}"
```

If an ECS service deployment is still `IN_PROGRESS`, ask ECS to roll it back so
the deployment state follows the traffic switch:

```bash
DEPLOYMENT_ARN="$(aws ecs list-service-deployments \
  --cluster "${CLUSTER}" \
  --service "${SERVICE}" \
  --query 'serviceDeployments[?status==`IN_PROGRESS`].serviceDeploymentArn | [0]' \
  --output text)"

test "${DEPLOYMENT_ARN}" != "None" && \
  aws ecs stop-service-deployment \
    --service-deployment-arn "${DEPLOYMENT_ARN}" \
    --stop-type ROLLBACK
```

## 4. Reconcile in IaC

After traffic is safe, make the declared state match what is now serving:

1. Revert the release image input to the last known-good image digest for the
   Core Case Service.
2. Run `terraform -chdir=infra/terraform plan` and confirm the service points
   at the last known-good task definition and keeps `strategy = "BLUE_GREEN"`.
3. Apply the reviewed plan through the normal release path.
4. Capture the incident ID, image digest, deployment ARN, listener rule ARN, and
   target group ARN in the incident notes.

Do not reintroduce a rolling deployment to recover. The rollback is the
blue/green traffic flip plus an IaC reconciliation of the image/task definition.

## 5. Verify Recovery

The rollback is complete only when all checks are true:

```bash
curl -fsS "http://${ALB_URL}/health"

aws cloudwatch describe-alarms \
  --alarm-names "${RELEASE_HEALTH_ALARM}" \
  --query 'MetricAlarms[].{AlarmName:AlarmName,State:StateValue}'

aws ecs describe-services \
  --cluster "${CLUSTER}" \
  --services "${SERVICE}" \
  --query 'services[].{running:runningCount,pending:pendingCount,deployments:deployments[].rolloutState}'
```

Close the rollback only after `/health` returns 200, the alarm states are `OK`,
ECS shows the service steady, and the X-Ray service map no longer shows the
release-correlated failing span.

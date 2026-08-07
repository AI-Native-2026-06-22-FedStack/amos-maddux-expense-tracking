# ECS Fargate and ALB floci verification

Date: 2026-08-07

All AWS CLI calls targeted local floci only:

```sh
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## Committed definitions

Task and service definitions are committed under `ecs/`.

- Core Case Service task: `expenseflow-core-case`
- GL-coding engine task: `expenseflow-gl-coding`
- Both task definitions set `networkMode` to `awsvpc`.
- Both task definitions set `requiresCompatibilities` to `["FARGATE"]`.
- Core Case Service uses CPU `512` and memory `1024`.
- GL-coding engine uses CPU `256` and memory `512`.
- Both task definitions use distinct role ARNs:
  - execution role: `arn:aws:iam::000000000000:role/expenseflow-ecs-execution-role`
  - task role: `arn:aws:iam::000000000000:role/expenseflow-app-task-role`
- Both task definitions reference fixed `m7d3-20260807-r2` image tags, not `latest`.

ALB inputs are committed under `alb/`.

- Load balancer: `expenseflow-public-alb`
- Target group: `expenseflow-api-tg`
- Target type: `ip`
- Health check path: `/ready`
- Listener: HTTP `80`
- Listener rule: `/v1` and `/v1/*` forward to the Core Case Service target group.

The original smoke image responded `404` on `/ready`, so the services were
rebuilt and pushed as `m7d3-20260807-r2`. The r2 Core Case Service image exposes
`/ready`, and the target group now health-checks that readiness endpoint.

## floci resources

ALB:

- ARN:
  `arn:aws:elasticloadbalancing:us-east-1:000000000000:loadbalancer/app/expenseflow-public-alb/b05ed4054cd34822`
- DNS:
  `expenseflow-public-alb-b05ed4054cd34822.elb.localhost`
- Scheme: `internet-facing`
- Security group: `sg-8fd0ef710c9071d28`
- Public subnets: `subnet-42ce98ee`, `subnet-5c8c0d81`

Target group:

- ARN:
  `arn:aws:elasticloadbalancing:us-east-1:000000000000:targetgroup/expenseflow-api-tg/445dcc7129904a93`
- Protocol: `HTTP`
- Port: `3000`
- Target type: `ip`
- Health check path: `/ready`
- Matcher: `200`

Listener:

- ARN:
  `arn:aws:elasticloadbalancing:us-east-1:000000000000:listener/app/expenseflow-public-alb/b05ed4054cd34822/73324fa2fdfb497d`
- `/v1` rule ARN:
  `arn:aws:elasticloadbalancing:us-east-1:000000000000:listener-rule/app/expenseflow-public-alb/b05ed4054cd34822/73324fa2fdfb497d/590050838b8b401c`

ECS:

- Requested cluster: `expenseflow-floci`
- floci-created runtime cluster: `default`
- Core Case Service task definition:
  `arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-core-case:3`
- GL-coding engine task definition:
  `arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-gl-coding:2`
- Core Case Service service:
  `arn:aws:ecs:us-east-1:000000000000:service/default/expenseflow-core-case-service`
- GL-coding engine service:
  `arn:aws:ecs:us-east-1:000000000000:service/default/expenseflow-gl-coding-service`

## Steady state

`describe-services` on floci's `default` cluster reported:

```text
expenseflow-core-case-service: desiredCount=1 runningCount=1 pendingCount=0
expenseflow-gl-coding-service: desiredCount=1 runningCount=1 pendingCount=0
```

Running replacement task records after stopping stale tasks:

```text
arn:aws:ecs:us-east-1:000000000000:task/default/c735bef7b1fd4b419572880f3f392cf4
  lastStatus=RUNNING
  desiredStatus=RUNNING
  group=expenseflow-core-case-service
  taskDefinition=arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-core-case:3
  image=localhost:5100/000000000000/us-east-1/expenseflow/core-case-service:m7d3-20260807-r2

arn:aws:ecs:us-east-1:000000000000:task/default/65272efa827e422ea19705c348f80651
  lastStatus=RUNNING
  desiredStatus=RUNNING
  group=expenseflow-gl-coding-service
  taskDefinition=arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-gl-coding:2
  image=localhost:5100/000000000000/us-east-1/expenseflow/gl-coding-engine:m7d3-20260807-r2
```

After rolling services forward, `describe-services` reported:

```text
expenseflow-core-case-service ACTIVE desiredCount=1 runningCount=1
  taskDefinition=arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-core-case:3

expenseflow-gl-coding-service ACTIVE desiredCount=1 runningCount=1
  taskDefinition=arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-gl-coding:2
```

Stopping stale running tasks:

```text
arn:aws:ecs:us-east-1:000000000000:task/default/5bd794f94f54458aaabddb51816b7c32
  lastStatus=STOPPED
  desiredStatus=STOPPED

arn:aws:ecs:us-east-1:000000000000:task/default/8fe5c5577ba04bc2911e9951ce4aea88
  lastStatus=STOPPED
  desiredStatus=STOPPED
```

floci then created replacement tasks:

```text
arn:aws:ecs:us-east-1:000000000000:task/default/c735bef7b1fd4b419572880f3f392cf4
  lastStatus=RUNNING
  desiredStatus=RUNNING
  taskDefinition=arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-core-case:3

arn:aws:ecs:us-east-1:000000000000:task/default/65272efa827e422ea19705c348f80651
  lastStatus=RUNNING
  desiredStatus=RUNNING
  taskDefinition=arn:aws:ecs:us-east-1:000000000000:task-definition/expenseflow-gl-coding:2
```

Target health after registering the rebuilt r2 local API endpoint:

```text
Target Id=172.19.0.8 Port=3000 State=healthy
HealthCheckPath=/ready
TargetType=ip
```

The rebuilt r2 service pair was verified on the private floci Docker network:

```text
http://expenseflow-compute-r2:8000/health 200 {"status":"ok"}
http://expenseflow-api-r2:3000/health 200 {"service":"ExpenseFlow API","status":"ok"}
http://expenseflow-api-r2:3000/ready 200 {"service":"ExpenseFlow API","status":"ready"}
```

The ALB listener on host port `8080` forwarded `/v1/*` traffic to the Core Case
Service target group. A probe to `/v1/auth/me` reached Express and returned an
application `404`, which confirms listener forwarding reached the API container.

## floci limitations observed

- Recreating floci reset in-memory EC2, IAM, and ECR control-plane metadata, so
  Task 1 and Task 2 metadata was recreated before this deploy. The registry
  sidecar still retained pushed image bytes.
- floci created services under the `default` cluster even when
  `cluster=expenseflow-floci` was supplied in the service input.
- floci `describe-task-definition` omitted some fields that were present in the
  committed registration input, including `requiresCompatibilities`,
  `executionRoleArn`, `taskRoleArn`, and container health checks.
- floci accepted the ECS service `loadBalancers` input but read it back as
  `null`, so the target was manually registered to exercise ALB health checks.
  The committed `ecs/service.json` remains the source of truth for the intended
  ECS-to-target-group registration.
- floci ELBv2 `RegisterTargets` and `DeregisterTargets` mutated state but
  returned malformed CLI response errors named `RegisterTargetsResult` and
  `DeregisterTargetsResult`.

# Network and IAM floci verification

Date: 2026-08-07

All AWS CLI calls targeted local floci only:

```sh
AWS_ENDPOINT_URL=http://localhost:4566
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
```

## VPC and subnets

Created VPC:

- `expenseflow-vpc`: `vpc-78eac74c`
- CIDR: `10.42.0.0/16`
- Internet gateway: `igw-401c9377`

Created public ALB subnets:

- `expenseflow-public-a`: `subnet-42ce98ee`, `10.42.0.0/24`, `us-east-1a`
- `expenseflow-public-b`: `subnet-5c8c0d81`, `10.42.1.0/24`, `us-east-1b`

Created private task subnets:

- `expenseflow-task-a`: `subnet-a0408ed5`, `10.42.10.0/24`, `us-east-1a`
- `expenseflow-task-b`: `subnet-dcb3026d`, `10.42.11.0/24`, `us-east-1b`

Created isolated DB subnets:

- `expenseflow-db-a`: `subnet-2d354f6f`, `10.42.20.0/24`, `us-east-1a`
- `expenseflow-db-b`: `subnet-8d188dee`, `10.42.21.0/24`, `us-east-1b`

## Route tables

Public route table:

- `expenseflow-public-rt`: `rtb-dc76ad97`
- Associated with `subnet-42ce98ee` and `subnet-5c8c0d81`
- Routes `0.0.0.0/0` to `igw-401c9377`

Private task route table:

- `expenseflow-task-rt`: `rtb-9e76ba3c`
- Associated with `subnet-a0408ed5` and `subnet-dcb3026d`
- floci 1.5.11 rejected `CreateNatGateway` as unsupported, so no default route
  was created in the emulator.

Isolated DB route table:

- `expenseflow-db-rt`: `rtb-f420ff10`
- Associated with `subnet-2d354f6f` and `subnet-8d188dee`
- No internet default route.

## Security groups

Created security groups:

- `expenseflow-alb-sg`: `sg-8fd0ef710c9071d28`
- `expenseflow-api-task-sg`: `sg-e5d28647385595786`
- `expenseflow-compute-task-sg`: `sg-308cf514067a24815`
- `expenseflow-db-sg`: `sg-e9f9e37c5f4a33130`

Committed intended rules are in `network/security-groups.json`:

- ALB allows TCP `80` from `0.0.0.0/0`.
- API task allows TCP `3000` from the ALB security group.
- Compute task allows TCP `8000` from the API task security group.
- DB allows TCP `5432` from the API and compute task security groups.

floci 1.5.11 accepted `authorize-security-group-ingress` calls with source
security group IDs, but `describe-security-groups` returned empty
`UserIdGroupPairs` arrays for those private rules. The inspection still confirms
that no private security group has an inbound `0.0.0.0/0` rule. Treat the
committed JSON as the source of truth for source-group chaining until Module 8
checks this against real AWS.

## IAM roles

Execution role:

- Role name: `expenseflow-ecs-execution-role`
- Role ARN: `arn:aws:iam::000000000000:role/expenseflow-ecs-execution-role`
- Attached policy:
  `arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy`

Task role:

- Role name: `expenseflow-app-task-role`
- Role ARN: `arn:aws:iam::000000000000:role/expenseflow-app-task-role`
- Inline policy: `expenseflow-runtime-secrets-read`
- Allowed action: `secretsmanager:GetSecretValue`
- Allowed resources:
  - `arn:aws:secretsmanager:us-east-1:000000000000:secret:expenseflow/local/db-password`
  - `arn:aws:secretsmanager:us-east-1:000000000000:secret:expenseflow/local/jwt-signing-keys`

The task role policy uses explicit actions and explicit secret ARNs only. It has
no `Action: "*"` and no `Resource: "*"`.

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

- `expenseflow-vpc`: `vpc-c67c89b4`
- CIDR: `10.42.0.0/16`
- Internet gateway: `igw-f69f60cf`

Created public ALB subnets:

- `expenseflow-public-a`: `subnet-56de6018`, `10.42.0.0/24`, `us-east-1a`
- `expenseflow-public-b`: `subnet-fdb821bf`, `10.42.1.0/24`, `us-east-1b`

Created private task subnets:

- `expenseflow-task-a`: `subnet-4f95624a`, `10.42.10.0/24`, `us-east-1a`
- `expenseflow-task-b`: `subnet-b0b92cb6`, `10.42.11.0/24`, `us-east-1b`

Created isolated DB subnets:

- `expenseflow-db-a`: `subnet-1bda8cff`, `10.42.20.0/24`, `us-east-1a`
- `expenseflow-db-b`: `subnet-345df5f0`, `10.42.21.0/24`, `us-east-1b`

## Route tables

Public route table:

- `expenseflow-public-rt`: `rtb-17fb2bbf`
- Associated with `subnet-56de6018` and `subnet-fdb821bf`
- Routes `0.0.0.0/0` to `igw-f69f60cf`

Private task route table:

- `expenseflow-task-rt`: `rtb-45030206`
- Associated with `subnet-4f95624a` and `subnet-b0b92cb6`
- floci 1.5.11 rejected `CreateNatGateway` as unsupported, so no default route
  was created in the emulator.

Isolated DB route table:

- `expenseflow-db-rt`: `rtb-9ab72b99`
- Associated with `subnet-1bda8cff` and `subnet-345df5f0`
- No internet default route.

## Security groups

Created security groups:

- `expenseflow-alb-sg`: `sg-17bf052d24246d38b`
- `expenseflow-api-task-sg`: `sg-1779db7ac9153fcc1`
- `expenseflow-compute-task-sg`: `sg-f6c13429eb0aa74f9`
- `expenseflow-db-sg`: `sg-2d79ce99d4dbe6d81`

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

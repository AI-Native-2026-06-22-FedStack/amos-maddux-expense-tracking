# ExpenseFlow Terraform

This root module owns the local floci base infrastructure for ExpenseFlow. It
uses one S3 backend and one state file for the stack. Child modules must not
declare their own backend.

## Bootstrap the Remote State Bucket

Terraform cannot initialize an S3 backend until the bucket already exists. Run
the idempotent bootstrap once before `terraform init`:

```sh
cd infra/terraform
AWS_ENDPOINT_URL=http://localhost:4566 \
AWS_REGION=us-east-1 \
./scripts/bootstrap-state-bucket.sh
```

The bucket is `expenseflow-terraform-state-floci`. The script keeps it private,
enables versioning, and enables default SSE-S3 encryption.

## Initialize and Plan

```sh
cd infra/terraform
terraform init
terraform validate
terraform plan
```

The backend key is `expenseflow/local/base/terraform.tfstate`, and native S3
locking is enabled by `use_lockfile = true`. There is no DynamoDB lock table.

floci 1.5.11 accepts subnet route table association and security group rule
calls, but the Terraform AWS provider waits for/read-checks shapes that floci
does not return consistently. The network module therefore creates VPCs,
subnets, route tables, routes, and security groups with AWS resources, then uses
Terraform-managed local floci commands for subnet route table associations and
security group rules.

## Lock Verification and Recovery

While an apply is in flight, Terraform writes the S3 lock object next to the
state object:

```sh
aws --endpoint-url http://localhost:4566 s3api list-objects-v2 \
  --bucket expenseflow-terraform-state-floci \
  --prefix expenseflow/local/base/
```

The lock object is
`expenseflow/local/base/terraform.tfstate.tflock`. If a lock becomes stale,
first confirm no `terraform apply` or `terraform plan` is still running. Then
recover with the lock ID Terraform prints in the error:

```sh
terraform force-unlock LOCK_ID
```

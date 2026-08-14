# ADR-0022: Terraform Module Structure

## Status

Accepted.

## Context

ExpenseFlow now has floci-verified network, IAM, ECS, ALB, and Lambda evidence,
but the base infrastructure is still represented as hand-authored JSON and
manual commands. The next module needs Terraform to become the source of truth
for infrastructure that ExpenseFlow creates and owns.

Terraform state also needs a remote backend with real locking semantics. The
S3 backend supports native lock files with `use_lockfile = true`; DynamoDB-based
locking is deprecated and should not be introduced for this local floci stack.

The deploy target remains local floci, not a real AWS account. The Terraform
layout should still preserve production-shaped review boundaries so future ECS,
ALB, Lambda, storage, and observability modules can consume stable base outputs.

## Decision

Create one Terraform root under `infra/terraform/` with one S3 backend and one
state key for the local base stack:

`expenseflow/local/base/terraform.tfstate`

The root calls separate child modules for network and IAM. The network module
owns topology and security-boundary resources: VPC, subnets, route tables,
internet gateway, and security groups. The IAM module owns identity and
permission resources: ECS execution role, application task role, managed policy
attachment, and the explicit runtime secrets-read policy.

Only the root declares the backend. Child modules do not declare backends or
separate states. Anything Terraform creates and owns is represented as a
resource. Anything pre-existing or externally owned, such as availability zones
or an optional shared hosted zone, is represented as a data source.

The backend bucket is bootstrapped before `terraform init` because Terraform
cannot initialize into a bucket that does not exist. The bucket is private,
versioned, encrypted, and the backend uses S3-native locking with
`use_lockfile = true`.

floci 1.5.11 accepts EC2 route table association and security group rule writes
but does not consistently return the read shapes expected by the Terraform AWS
provider. The local base therefore creates VPCs, subnets, route tables, routes,
and security groups as AWS resources, and performs subnet route table
associations and security group rule writes through Terraform-managed local
floci commands until real AWS verification can use native association and rule
resources.

## Alternatives Considered

- One flat root module: Rejected because networking and IAM change for
  different reasons and should stay separately reviewable as later application
  modules are added.
- Separate state per child module: Rejected because the base layer is small and
  shared outputs are needed together by the next modules. Splitting state would
  add dependency ordering and remote-state coupling before it buys useful
  isolation.
- DynamoDB lock table: Rejected because S3-native lock files are available and
  DynamoDB-based locking is deprecated for the Terraform S3 backend.
- Managing shared infrastructure as resources: Rejected because Terraform would
  then try to own and potentially destroy infrastructure ExpenseFlow should only
  read.

## Consequences

POSITIVE: The base layer has one state file, one lock path, and one clear
initialization flow for local floci.

POSITIVE: Network and IAM stay independently reviewable while exposing stable
outputs for ECS, ALB, Lambda, and database modules.

POSITIVE: Terraform ownership is explicit: created infrastructure is a resource,
and pre-existing infrastructure is a data source.

POSITIVE: S3-native locking avoids introducing the deprecated DynamoDB locking
pattern.

NEGATIVE: The backend bucket requires a small bootstrap step before the first
`terraform init`.

NEGATIVE: floci networking support remains approximate; NAT gateway routing is
intentionally omitted from this local base and must be revisited for real AWS.

NEGATIVE: floci route table association and security group rule reads require a
local compatibility path that should be replaced with native Terraform AWS
resources in real AWS.

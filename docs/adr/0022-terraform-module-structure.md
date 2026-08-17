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

---

## Module Boundaries (Extended)

### Layer 1: Foundation (Network + IAM)

**Module: `network`**

- Owns: VPC, subnets (public / private-task / isolated-db tiers), route tables, internet gateway, security groups
- Outputs: `vpc_id`, `subnet_ids_by_tier`, `security_group_ids`, `shared_zone`
- Isolation: Network topology changes do not affect IAM; security groups are named and indexed by purpose, not consumed directly as resource references

**Module: `iam`**

- Owns: ECS execution role, application task role, deduction-scan Lambda execution role, managed policy attachments, runtime secrets-read policy
- Outputs: `ecs_execution_role_arn`, `ecs_execution_role_name`, `app_task_role_arn`, `app_task_role_name`, `lambda_deduction_scan_role_arn`, `lambda_deduction_scan_role_name`
- Isolation: IAM roles are independent of network topology; roles accept only `stack_name` and `aws_region`

**Composition: root invokes both modules in parallel**

```hcl
module "network" { ... }
module "iam" { ... }
```

No dependencies between network and IAM; both compute independently and expose stable, named outputs.

---

### Layer 2: Data (RDS, DynamoDB, Redis, SNS/SQS)

**Module: `data`**

- Owns: Aurora RDS cluster, RDS parameter groups, KMS keys for encryption, DynamoDB tables (case-queue rollup, idempotency), ElastiCache Redis, SNS stage-events topic, SQS stage-projection queue + DLQ
- Receives through typed variables:
  - `vpc_id` (from `module.network`)
  - `subnet_ids_isolated_db` (from `module.network.subnet_ids_by_tier["isolated_db"]`)
  - `security_group_id_db` (from `module.network.security_group_ids["db"]`)
- Outputs: RDS endpoint/port/database name, DynamoDB table names, Redis endpoint/port, SNS topic ARN/name, SQS queue URLs/ARNs, DLQ URLs
- Isolation: Data layer does not reference network or IAM module resources; only receives identifiers as input variables

**Composition: root invokes data after network**

```hcl
module "data" {
  vpc_id                 = module.network.vpc_id
  subnet_ids_isolated_db = module.network.subnet_ids_by_tier["isolated_db"]
  security_group_id_db   = module.network.security_group_ids["db"]
}
```

All VPC, subnet, and security group IDs flow through root invocation; data module never reaches into `module.network.aws_subnet` or similar.

---

### Layer 3: Application (ECS, ALB, Lambda)

**Module: `app`**

- Owns: ECS cluster (Fargate + Spot capacity), ALB, target groups, listeners, ECS task definitions (API and compute), ECS services, CloudWatch log groups, Lambda for deduction scan
- Receives through typed variables (43 inputs):
  - Network: VPC ID, public/private-task subnet IDs, ALB/API/compute security group IDs
  - IAM: execution role, task role, and Lambda execution role ARNs/names
  - Data: RDS endpoint/port/database name, DynamoDB table names, Redis endpoint/port, SNS topic ARN/name, SQS queue URLs/ARNs
  - Container images and ports (with defaults)
- Outputs: ECS cluster name/ARN, API and compute service names/ARNs, ALB ARN/DNS name, CloudWatch log groups, Lambda ARN/name
- Isolation: App layer does not reference network, IAM, or data module resources directly; only receives output values as typed inputs

**Composition: root invokes app after data**

```hcl
module "app" {
  # Network outputs
  vpc_id                 = module.network.vpc_id
  subnet_ids_public      = module.network.subnet_ids_by_tier["public"]
  # ... (security group IDs from module.network)

  # IAM outputs
  ecs_execution_role_arn = module.iam.ecs_execution_role_arn
  # ... (role names from module.iam)

  # Data outputs
  rds_cluster_endpoint = module.data.rds_cluster_endpoint
  # ... (all DB, cache, queue/topic values from module.data)
}
```

App module never contains references to `aws_rds_cluster.expenseflow` or `aws_lb_target_group.api` from other modules.

---

### Layer 4: Observability (Interface)

**Module: `observability`**

- Owns: Nothing (interface-only, no resources created yet)
- Receives through typed variables (11 inputs from app layer):
  - ECS cluster name/ARN, API/compute service names/ARNs, ALB ARN, CloudWatch log group names
- Outputs: None (placeholder, to be extended with dashboards, alarms, metrics)
- Isolation: Observability is a pure consumer; cannot reference network, IAM, data, or app module resources directly

**Composition: root invokes observability after app**

```hcl
module "observability" {
  ecs_cluster_name      = module.app.ecs_cluster_name
  alb_arn               = module.app.alb_arn
  api_cloudwatch_log_group = module.app.api_cloudwatch_log_group
  # ... (all app outputs passed through)
}
```

Observability is a contract boundary: future dashboard and alarm resources will depend only on outputs declared by app module.

---

## Module Composition Pattern: Prohibition of Copied IDs

**REJECTED:** Copying or hard-coding resource identifiers downstream.

```hcl
# ❌ PROHIBITED
module "app" {
  rds_endpoint = "expenseflow-db-1.c9akciq32.us-east-1.rds.amazonaws.com"  # Hard-coded
  subnet_id    = "subnet-abc123"  # Copied from network
}

# ❌ PROHIBITED
module "app" {
  rds_endpoint = module.data.aws_rds_cluster.expenseflow.endpoint  # Direct resource reference
}

# ✅ REQUIRED
module "app" {
  rds_cluster_endpoint = module.data.rds_cluster_endpoint  # Output reference only
}

# ✅ REQUIRED (composition at root)
module "app" {
  rds_cluster_endpoint = module.data.rds_cluster_endpoint
  vpc_id               = module.network.vpc_id
  # All dependencies flow through root main.tf via module.<name>.<output>
}
```

**Rationale:**

- Copied IDs break when resources are recreated or renamed
- Direct resource references create hidden dependencies not captured in Terraform's module interface
- Centralized composition at root allows single-point review of cross-module dependencies
- Typed variables enforce contracts: if an input is needed, it must be declared and passed explicitly
- Outputs are versioned; adding a new output does not break existing modules (additive change)

---

## Output/Input Seams

Each module declares typed inputs and outputs forming explicit seams:

| Layer         | Module        | Inputs                                                                                 | Outputs                                                                                     | Seam Type           |
| ------------- | ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| Base          | network       | `stack_name`, `aws_region`, `floci_endpoint_url`, `shared_zone_name`                   | `vpc_id`, `subnet_ids_by_tier`, `security_group_ids`, `shared_zone`                         | Topology boundary   |
| Base          | iam           | `stack_name`, `aws_region`                                                             | `ecs_execution_role_arn`, `app_task_role_arn`, `lambda_deduction_scan_role_arn`, role names | Identity boundary   |
| Data          | data          | `vpc_id`, `subnet_ids_isolated_db`, `security_group_id_db`, `stack_name`, `aws_region` | RDS/DynamoDB/Redis/SNS/SQS endpoints, arns, names                                           | Storage boundary    |
| App           | app           | 43 typed inputs from network, IAM, data, plus container images                         | ECS services, ALB, Lambda, log groups                                                       | Workload boundary   |
| Observability | observability | 11 typed inputs from app, `stack_name`, `aws_region`                                   | None yet                                                                                    | Monitoring boundary |

Each seam is:

1. **Declared:** Inputs listed in `variables.tf`, outputs in `outputs.tf`
2. **Typed:** Strings, numbers, lists, or objects with known structure
3. **Named:** Purpose-driven names (e.g., `rds_cluster_endpoint`, not `db_host`)
4. **Tested:** Terraform validates that outputs match input types at composition time

---

## Tradeoffs

**POSITIVE: Composition at root is centralized and reviewable**

- All cross-module dependencies visible in one file (`main.tf`)
- Adding a new module or changing a dependency requires a single point of change
- Git review of `main.tf` captures the full dependency graph

**POSITIVE: Modules remain independently testable**

- Each module accepts only typed inputs; no hidden dependencies on Terraform registry or shared state
- A module can be tested by passing mock values; no need to run other modules first
- Tests can validate that each module produces expected outputs given inputs

**POSITIVE: Output/input seams are stable contracts**

- A module can add new outputs without breaking existing consumers (additive)
- A module can add optional inputs without breaking existing invocations (with defaults)
- Removing an output or changing an input type is a breaking change, caught immediately by root main.tf compilation

**NEGATIVE: Composition complexity grows with module count**

- Root main.tf becomes longer as each layer adds a module
- Mitigation: Keep root main.tf focused on composition; move configuration to variables.tf

**NEGATIVE: No automatic dependency ordering between layers**

- Terraform infers dependencies from `module.x.output` references; if a module forgets a reference, the dependency is missed
- Mitigation: Use explicit `depends_on` in root main.tf when needed; tests validate dependency DAG

**NEGATIVE: Output explosion if every internal resource is exported**

- Over-exporting outputs creates coupling: if a module exports an internal resource ID, consumers may use it
- Mitigation: Export only stable, typed outputs; mark sensitive outputs; document ownership

---

## Summary

The module structure enforces a composition model where:

1. **Network and IAM are the foundation:** Horizontal, independent, shared by all layers
2. **Data owns stateful infrastructure:** Receives network and security policies from foundation; exports endpoints and ARNs
3. **App owns compute and workload logic:** Consumes all foundation and data outputs; exports cluster, service, and ALB identifiers
4. **Observability is a consumer boundary:** Accepts app outputs; reserves right to create dashboards and alarms later
5. **Root orchestrates all composition:** Single file documents all inter-module dependencies; no module reaches into another's resources

This pattern scales to future modules (storage, networking-next, audit) without changing the composition rules.

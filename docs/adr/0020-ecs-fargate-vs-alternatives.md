# ADR-0020: ECS Fargate for ExpenseFlow Backend Runtime

## Status

Accepted.

## Context

ExpenseFlow needs a production-shaped runtime for the Core Case Service and the
GL-coding engine after the m7d1 image hardening and m7d2 Compose work. The
runtime must run long-lived containers, replace failed tasks, sit behind an ALB,
and keep the operational surface small enough for a cohort-sized delivery team.

The deploy target for this module is floci, not a real AWS account. The
definitions still need to mirror real ECS/Fargate semantics so Module 8 can lift
them into real cloud infrastructure with fewer surprises.

## Decision

Use ECS Fargate services for the two long-lived ExpenseFlow backend workloads.
Each service gets a committed task definition with `requiresCompatibilities:
["FARGATE"]`, `networkMode: "awsvpc"`, valid CPU/memory sizing, immutable ECR
image tags, and distinct execution and task role ARNs.

The internet-facing ALB routes `/v1` traffic to the Core Case Service target
group. The GL-coding engine remains private and is reached by the Core Case
Service over service-to-service networking.

## Alternatives Considered

- Self-managed Kubernetes cluster: Rejected because operating the control
  plane, node lifecycle, ingress, workload identity, patching, and cluster
  policy is not worth it for a small team running two backend services.
- ECS on EC2: Rejected because it reintroduces host patching, capacity
  management, and node draining work that Fargate removes for this cohort.
- Compose on a VM: Rejected because it lacks first-class cloud load balancing,
  task replacement, and IAM role boundaries for the deployed service model.
- Serverless functions: Rejected because both services are long-lived HTTP
  workloads with database connections, readiness checks, and container images
  that already fit ECS services.

## Consequences

POSITIVE: The team gets managed container scheduling without owning cluster
nodes or a Kubernetes control plane.

POSITIVE: Task definitions, service definitions, ALB resources, and IAM role
references remain version-controlled instead of hand-edited in a console.

POSITIVE: Fargate `awsvpc` networking aligns with private subnet placement and
`ip` target groups behind the ALB.

NEGATIVE: Fargate gives less low-level host control than EC2-backed containers.

NEGATIVE: Some floci ECS, ELB, and networking behavior is approximate, so Module
8 must verify health checks, target registration, and replacement behavior
against real AWS.

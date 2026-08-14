variable "stack_name" {
  description = "Name prefix for ExpenseFlow IAM resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region modeled by local floci."
  type        = string
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  secrets_manager_resource_prefix = join(":", [
    "arn",
    data.aws_partition.current.partition,
    "secretsmanager",
    var.aws_region,
    data.aws_caller_identity.current.account_id,
    "secret",
  ])

  ecs_task_execution_policy_arn = join(":", [
    "arn",
    data.aws_partition.current.partition,
    "iam",
    "",
    "aws",
    "policy/service-role/AmazonECSTaskExecutionRolePolicy",
  ])
}

data "aws_iam_policy_document" "ecs_task_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

data "aws_iam_policy_document" "runtime_secrets_read" {
  statement {
    sid     = "ReadRuntimeSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]

    resources = [
      "${local.secrets_manager_resource_prefix}:${var.stack_name}/local/db-password",
      "${local.secrets_manager_resource_prefix}:${var.stack_name}/local/jwt-signing-keys",
    ]
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.stack_name}-ecs-execution-role"
  description        = "ECS launch-agent role for pulling images, fetching launch-time secrets, and writing logs."
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = local.ecs_task_execution_policy_arn
}

resource "aws_iam_role" "app_task" {
  name               = "${var.stack_name}-app-task-role"
  description        = "Runtime task role for ExpenseFlow application code."
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume_role.json
}

resource "aws_iam_role_policy" "runtime_secrets_read" {
  name   = "${var.stack_name}-runtime-secrets-read"
  role   = aws_iam_role.app_task.id
  policy = data.aws_iam_policy_document.runtime_secrets_read.json
}

output "ecs_execution_role_name" {
  description = "Name of the ECS task execution role."
  value       = aws_iam_role.ecs_execution.name
}

output "ecs_execution_role_arn" {
  description = "ARN of the ECS task execution role."
  value       = aws_iam_role.ecs_execution.arn
  sensitive   = true
}

output "app_task_role_name" {
  description = "Name of the ExpenseFlow application task role."
  value       = aws_iam_role.app_task.name
}

output "app_task_role_arn" {
  description = "ARN of the ExpenseFlow application task role."
  value       = aws_iam_role.app_task.arn
  sensitive   = true
}

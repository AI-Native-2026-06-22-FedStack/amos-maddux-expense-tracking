output "vpc_id" {
  description = "ID of the ExpenseFlow VPC."
  value       = module.network.vpc_id
}

output "subnet_ids_by_tier" {
  description = "Subnet IDs grouped by public, private task, and isolated DB tiers."
  value       = module.network.subnet_ids_by_tier
}

output "security_group_ids" {
  description = "Security group IDs keyed by purpose."
  value       = module.network.security_group_ids
}

output "shared_zone" {
  description = "Optional externally owned Route53 hosted zone read by Terraform."
  value       = module.network.shared_zone
}

output "ecs_execution_role_name" {
  description = "Name of the ECS task execution role."
  value       = module.iam.ecs_execution_role_name
}

output "ecs_execution_role_arn" {
  description = "ARN of the ECS task execution role."
  value       = module.iam.ecs_execution_role_arn
  sensitive   = true
}

output "app_task_role_name" {
  description = "Name of the ExpenseFlow application task role."
  value       = module.iam.app_task_role_name
}

output "app_task_role_arn" {
  description = "ARN of the ExpenseFlow application task role."
  value       = module.iam.app_task_role_arn
  sensitive   = true
}

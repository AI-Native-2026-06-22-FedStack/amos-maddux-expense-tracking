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

output "lambda_deduction_scan_role_name" {
  description = "Name of the deduction scan Lambda execution role."
  value       = module.iam.lambda_deduction_scan_role_name
}

output "lambda_deduction_scan_role_arn" {
  description = "ARN of the deduction scan Lambda execution role."
  value       = module.iam.lambda_deduction_scan_role_arn
  sensitive   = true
}

# Data Layer Outputs
output "rds_cluster_endpoint" {
  description = "RDS cluster endpoint for database connections."
  value       = module.data.rds_cluster_endpoint
}

output "rds_cluster_arn" {
  description = "ARN of the RDS cluster."
  value       = module.data.rds_cluster_arn
  sensitive   = true
}

output "rds_database_name" {
  description = "Name of the default RDS database."
  value       = module.data.rds_database_name
}

output "rds_port" {
  description = "Port of the RDS cluster."
  value       = module.data.rds_port
}

output "db_password_secret_arn" {
  description = "ARN of the Secrets Manager secret container for database password."
  value       = module.data.db_password_secret_arn
  sensitive   = true
}

output "dynamodb_case_queue_rollup_table_name" {
  description = "DynamoDB table name for case queue rollup."
  value       = module.data.dynamodb_case_queue_rollup_table_name
}

output "dynamodb_case_queue_rollup_table_arn" {
  description = "ARN of the case queue rollup DynamoDB table."
  value       = module.data.dynamodb_case_queue_rollup_table_arn
  sensitive   = true
}

output "dynamodb_idempotency_table_name" {
  description = "DynamoDB table name for idempotency."
  value       = module.data.dynamodb_idempotency_table_name
}

output "dynamodb_idempotency_table_arn" {
  description = "ARN of the idempotency DynamoDB table."
  value       = module.data.dynamodb_idempotency_table_arn
  sensitive   = true
}

output "elasticache_redis_endpoint" {
  description = "Redis cluster endpoint for cache connections."
  value       = module.data.elasticache_redis_endpoint
}

output "elasticache_redis_port" {
  description = "Redis cluster port."
  value       = module.data.elasticache_redis_port
}

output "sns_stage_events_topic_arn" {
  description = "ARN of the SNS topic for stage transition events."
  value       = module.data.sns_stage_events_topic_arn
  sensitive   = true
}

output "sns_stage_events_topic_name" {
  description = "Name of the SNS topic for stage transition events."
  value       = module.data.sns_stage_events_topic_name
}

output "sqs_stage_projection_queue_url" {
  description = "URL of the SQS queue for stage projection events."
  value       = module.data.sqs_stage_projection_queue_url
}

output "sqs_stage_projection_queue_arn" {
  description = "ARN of the SQS queue for stage projection events."
  value       = module.data.sqs_stage_projection_queue_arn
  sensitive   = true
}

output "sqs_stage_projection_dlq_url" {
  description = "URL of the SQS DLQ for stage projection events."
  value       = module.data.sqs_stage_projection_dlq_url
}

output "sqs_stage_projection_dlq_arn" {
  description = "ARN of the SQS DLQ for stage projection events."
  value       = module.data.sqs_stage_projection_dlq_arn
  sensitive   = true
}

# App Layer Outputs
output "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  value       = module.app.ecs_cluster_name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = module.app.ecs_cluster_arn
  sensitive   = true
}

output "api_service_name" {
  description = "Name of the API ECS service."
  value       = module.app.api_service_name
}

output "api_service_arn" {
  description = "ARN of the API ECS service."
  value       = module.app.api_service_arn
  sensitive   = true
}

output "compute_service_name" {
  description = "Name of the compute ECS service."
  value       = module.app.compute_service_name
}

output "compute_service_arn" {
  description = "ARN of the compute ECS service."
  value       = module.app.compute_service_arn
  sensitive   = true
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer."
  value       = module.app.alb_arn
  sensitive   = true
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer."
  value       = module.app.alb_dns_name
}

output "api_primary_target_group_arn" {
  description = "Primary target group ARN for the Core Case Service blue/green service."
  value       = module.app.api_primary_target_group_arn
  sensitive   = true
}

output "api_alternate_target_group_arn" {
  description = "Alternate target group ARN for the Core Case Service blue/green service."
  value       = module.app.api_alternate_target_group_arn
  sensitive   = true
}

output "api_production_listener_rule_arn" {
  description = "Production listener rule ARN that ECS switches during Core Case Service blue/green cutovers."
  value       = module.app.api_production_listener_rule_arn
  sensitive   = true
}

output "release_health_alarm_name" {
  description = "CloudWatch alarm name for the first post-release golden-signal alarm."
  value       = module.observability.release_health_alarm_name
}

output "api_cloudwatch_log_group" {
  description = "CloudWatch log group for API service."
  value       = module.app.api_cloudwatch_log_group
}

output "compute_cloudwatch_log_group" {
  description = "CloudWatch log group for compute service."
  value       = module.app.compute_cloudwatch_log_group
}

output "lambda_deduction_scan_arn" {
  description = "ARN of the deduction scan Lambda function."
  value       = module.app.lambda_deduction_scan_arn
  sensitive   = true
}

output "lambda_deduction_scan_function_name" {
  description = "Name of the deduction scan Lambda function."
  value       = module.app.lambda_deduction_scan_function_name
}

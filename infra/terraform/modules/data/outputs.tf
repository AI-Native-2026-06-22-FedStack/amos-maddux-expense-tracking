output "rds_cluster_endpoint" {
  description = "RDS cluster endpoint for ExpenseFlow database connections."
  value       = aws_rds_cluster.expenseflow.endpoint
}

output "rds_cluster_reader_endpoint" {
  description = "RDS cluster reader endpoint for read replicas."
  value       = aws_rds_cluster.expenseflow.reader_endpoint
}

output "rds_cluster_arn" {
  description = "ARN of the RDS cluster."
  value       = aws_rds_cluster.expenseflow.arn
  sensitive   = true
}

output "rds_database_name" {
  description = "Name of the default RDS database."
  value       = aws_rds_cluster.expenseflow.database_name
}

output "rds_master_username" {
  description = "Master username for RDS."
  value       = aws_rds_cluster.expenseflow.master_username
}

output "rds_port" {
  description = "Port of the RDS cluster."
  value       = aws_rds_cluster.expenseflow.port
}

output "db_password_secret_arn" {
  description = "ARN of the Secrets Manager secret container for database password."
  value       = aws_secretsmanager_secret.db_password.arn
  sensitive   = true
}

output "dynamodb_case_queue_rollup_table_name" {
  description = "DynamoDB table name for case queue rollup."
  value       = aws_dynamodb_table.case_queue_rollup.name
}

output "dynamodb_case_queue_rollup_table_arn" {
  description = "ARN of the case queue rollup DynamoDB table."
  value       = aws_dynamodb_table.case_queue_rollup.arn
  sensitive   = true
}

output "dynamodb_idempotency_table_name" {
  description = "DynamoDB table name for idempotency."
  value       = aws_dynamodb_table.idempotency.name
}

output "dynamodb_idempotency_table_arn" {
  description = "ARN of the idempotency DynamoDB table."
  value       = aws_dynamodb_table.idempotency.arn
  sensitive   = true
}

output "elasticache_redis_endpoint" {
  description = "Redis cluster endpoint address for cache connections."
  value       = aws_elasticache_cluster.expenseflow.cache_nodes[0].address
}

output "elasticache_redis_port" {
  description = "Redis cluster port."
  value       = aws_elasticache_cluster.expenseflow.port
}

output "elasticache_security_group_id" {
  description = "Security group ID for the Redis cluster."
  value       = aws_security_group.cache.id
}

output "sns_stage_events_topic_arn" {
  description = "ARN of the SNS topic for stage transition events."
  value       = aws_sns_topic.stage_events.arn
  sensitive   = true
}

output "sns_stage_events_topic_name" {
  description = "Name of the SNS topic for stage transition events."
  value       = aws_sns_topic.stage_events.name
}

output "sqs_stage_projection_queue_url" {
  description = "URL of the SQS queue for stage projection events."
  value       = aws_sqs_queue.stage_projection.url
}

output "sqs_stage_projection_queue_arn" {
  description = "ARN of the SQS queue for stage projection events."
  value       = aws_sqs_queue.stage_projection.arn
  sensitive   = true
}

output "sqs_stage_projection_dlq_url" {
  description = "URL of the SQS DLQ for stage projection events."
  value       = aws_sqs_queue.stage_projection_dlq.url
}

output "sqs_stage_projection_dlq_arn" {
  description = "ARN of the SQS DLQ for stage projection events."
  value       = aws_sqs_queue.stage_projection_dlq.arn
  sensitive   = true
}

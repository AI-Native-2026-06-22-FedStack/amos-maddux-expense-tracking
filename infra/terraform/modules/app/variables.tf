variable "stack_name" {
  description = "Name prefix for ExpenseFlow application resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region modeled by local floci."
  type        = string
}

# ===== Network =====
variable "vpc_id" {
  description = "VPC ID where application resources are deployed."
  type        = string
}

variable "subnet_ids_public" {
  description = "Public tier subnet IDs for ALB."
  type        = list(string)
  validation {
    condition     = length(var.subnet_ids_public) >= 2
    error_message = "At least 2 public subnets are required for ALB."
  }
}

variable "subnet_ids_private_task" {
  description = "Private task tier subnet IDs for ECS services."
  type        = list(string)
  validation {
    condition     = length(var.subnet_ids_private_task) >= 2
    error_message = "At least 2 private task subnets are required for ECS."
  }
}

variable "security_group_id_alb" {
  description = "Security group ID for the ALB."
  type        = string
}

variable "security_group_id_api_task" {
  description = "Security group ID for the API task."
  type        = string
}

variable "security_group_id_compute_task" {
  description = "Security group ID for the compute task."
  type        = string
}

# ===== IAM =====
variable "ecs_execution_role_arn" {
  description = "ARN of the ECS task execution role."
  type        = string
  sensitive   = true
}

variable "ecs_execution_role_name" {
  description = "Name of the ECS task execution role."
  type        = string
}

variable "app_task_role_arn" {
  description = "ARN of the application task role."
  type        = string
  sensitive   = true
}

variable "app_task_role_name" {
  description = "Name of the application task role."
  type        = string
}

variable "lambda_deduction_scan_role_arn" {
  description = "ARN of the deduction scan Lambda execution role."
  type        = string
  sensitive   = true
}

# ===== Data Layer =====
variable "rds_cluster_endpoint" {
  description = "RDS cluster endpoint for database connections."
  type        = string
}

variable "rds_database_name" {
  description = "Name of the RDS database."
  type        = string
}

variable "rds_port" {
  description = "Port of the RDS database."
  type        = number
}

variable "rds_master_username" {
  description = "Master username for RDS database."
  type        = string
}

variable "db_password_secret_arn" {
  description = "ARN of the Secrets Manager secret for the database password."
  type        = string
  sensitive   = true
}

variable "dynamodb_case_queue_rollup_table_name" {
  description = "Name of the DynamoDB case queue rollup table."
  type        = string
}

variable "dynamodb_idempotency_table_name" {
  description = "Name of the DynamoDB idempotency table."
  type        = string
}

variable "elasticache_redis_endpoint" {
  description = "ElastiCache Redis cluster endpoint."
  type        = string
}

variable "elasticache_redis_port" {
  description = "ElastiCache Redis cluster port."
  type        = number
}

variable "sns_stage_events_topic_arn" {
  description = "ARN of the SNS topic for stage transition events."
  type        = string
  sensitive   = true
}

variable "sns_stage_events_topic_name" {
  description = "Name of the SNS topic for stage transition events."
  type        = string
}

variable "sqs_stage_projection_queue_url" {
  description = "URL of the SQS queue for stage projection events."
  type        = string
}

variable "sqs_stage_projection_queue_arn" {
  description = "ARN of the SQS queue for stage projection events."
  type        = string
  sensitive   = true
}

variable "sqs_stage_projection_dlq_url" {
  description = "URL of the SQS DLQ for stage projection events."
  type        = string
}

# ===== Container Images =====
variable "container_image_api" {
  description = "Container image URI for the API service."
  type        = string
  default     = "localhost:5000/expenseflow-api:local"
}

variable "container_image_compute" {
  description = "Container image URI for the compute service."
  type        = string
  default     = "localhost:5000/expenseflow-compute:local"
}

variable "container_port_api" {
  description = "Container port for the API service."
  type        = number
  default     = 3000
}

variable "container_port_compute" {
  description = "Container port for the compute service."
  type        = number
  default     = 8000
}

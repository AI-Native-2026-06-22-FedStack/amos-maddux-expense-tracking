variable "stack_name" {
  description = "Name prefix for ExpenseFlow observability resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region modeled by local floci."
  type        = string
}

variable "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  type        = string
}

variable "ecs_cluster_arn" {
  description = "ARN of the ECS cluster."
  type        = string
  sensitive   = true
}

variable "api_service_name" {
  description = "Name of the API ECS service."
  type        = string
}

variable "api_service_arn" {
  description = "ARN of the API ECS service."
  type        = string
  sensitive   = true
}

variable "compute_service_name" {
  description = "Name of the compute ECS service."
  type        = string
}

variable "compute_service_arn" {
  description = "ARN of the compute ECS service."
  type        = string
  sensitive   = true
}

variable "alb_arn" {
  description = "ARN of the Application Load Balancer."
  type        = string
  sensitive   = true
}

variable "api_cloudwatch_log_group" {
  description = "CloudWatch log group for API service."
  type        = string
}

variable "compute_cloudwatch_log_group" {
  description = "CloudWatch log group for compute service."
  type        = string
}

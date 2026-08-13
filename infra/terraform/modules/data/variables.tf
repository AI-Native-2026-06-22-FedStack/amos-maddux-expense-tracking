variable "stack_name" {
  description = "Name prefix for ExpenseFlow data resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region modeled by local floci."
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where data resources are deployed."
  type        = string
}

variable "subnet_ids_isolated_db" {
  description = "Isolated DB tier subnet IDs for RDS and database resources."
  type        = list(string)
  validation {
    condition     = length(var.subnet_ids_isolated_db) >= 2
    error_message = "At least 2 isolated DB subnets are required for multi-AZ deployments."
  }
}

variable "security_group_id_db" {
  description = "Security group ID for database ingress rules."
  type        = string
}

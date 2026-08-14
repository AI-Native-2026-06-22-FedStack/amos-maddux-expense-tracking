variable "aws_region" {
  description = "AWS region modeled by local floci."
  type        = string
  default     = "us-east-1"
}

variable "floci_endpoint_url" {
  description = "Host-side endpoint URL for local floci AWS APIs."
  type        = string
  default     = "http://localhost:4566"
}

variable "stack_name" {
  description = "Name prefix for ExpenseFlow infrastructure resources."
  type        = string
  default     = "expenseflow"
}

variable "shared_zone_name" {
  description = "Optional pre-existing Route53 hosted zone name to read, not manage."
  type        = string
  default     = null
}

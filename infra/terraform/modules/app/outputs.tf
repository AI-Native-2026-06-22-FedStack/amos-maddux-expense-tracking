output "ecs_cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.expenseflow.name
}

output "ecs_cluster_arn" {
  description = "ARN of the ECS cluster."
  value       = aws_ecs_cluster.expenseflow.arn
  sensitive   = true
}

output "api_service_name" {
  description = "Name of the API ECS service."
  value       = aws_ecs_service.api.name
}

output "api_service_arn" {
  description = "ARN of the API ECS service."
  value       = aws_ecs_service.api.arn
  sensitive   = true
}

output "compute_service_name" {
  description = "Name of the compute ECS service."
  value       = aws_ecs_service.compute.name
}

output "compute_service_arn" {
  description = "ARN of the compute ECS service."
  value       = aws_ecs_service.compute.arn
  sensitive   = true
}

output "alb_arn" {
  description = "ARN of the Application Load Balancer."
  value       = aws_lb.expenseflow.arn
  sensitive   = true
}

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer."
  value       = aws_lb.expenseflow.dns_name
}

output "api_primary_target_group_arn" {
  description = "Primary target group ARN for the Core Case Service blue/green service."
  value       = aws_lb_target_group.api.arn
  sensitive   = true
}

output "api_alternate_target_group_arn" {
  description = "Alternate target group ARN for the Core Case Service blue/green service."
  value       = aws_lb_target_group.api_alternate.arn
  sensitive   = true
}

output "api_production_listener_rule_arn" {
  description = "Production listener rule ARN that ECS switches during Core Case Service blue/green cutovers."
  value       = aws_lb_listener_rule.api_production.arn
  sensitive   = true
}

output "api_cloudwatch_log_group" {
  description = "CloudWatch log group for API service."
  value       = aws_cloudwatch_log_group.api.name
}

output "compute_cloudwatch_log_group" {
  description = "CloudWatch log group for compute service."
  value       = aws_cloudwatch_log_group.compute.name
}

output "lambda_deduction_scan_arn" {
  description = "ARN of the deduction scan Lambda function."
  value       = aws_lambda_function.deduction_scan.arn
  sensitive   = true
}

output "lambda_deduction_scan_function_name" {
  description = "Name of the deduction scan Lambda function."
  value       = aws_lambda_function.deduction_scan.function_name
}

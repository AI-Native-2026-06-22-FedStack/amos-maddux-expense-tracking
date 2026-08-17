output "release_health_alarm_name" {
  description = "Name of the first post-release golden-signal alarm."
  value       = aws_cloudwatch_metric_alarm.release_health.alarm_name
}

output "release_health_alarm_arn" {
  description = "ARN of the first post-release golden-signal alarm."
  value       = aws_cloudwatch_metric_alarm.release_health.arn
  sensitive   = true
}

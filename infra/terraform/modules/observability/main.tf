locals {
  alb_arn_suffix = element(split("loadbalancer/", var.alb_arn), 1)
}

resource "aws_cloudwatch_metric_alarm" "release_health" {
  alarm_name          = "${var.stack_name}-release-health"
  alarm_description   = "Core Case Service ALB target latency exceeded ${var.release_latency_threshold_seconds}s for ${var.release_latency_evaluation_periods} consecutive periods. Runbook: docs/runbook-rollback.md"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = var.release_latency_evaluation_periods
  threshold           = var.release_latency_threshold_seconds
  period              = 60
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  statistic           = "Average"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = local.alb_arn_suffix
  }

  tags = { Name = "${var.stack_name}-release-health-alarm" }
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# ====== ECS Cluster ======

resource "aws_ecs_cluster" "expenseflow" {
  name = "${var.stack_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${var.stack_name}-ecs-cluster" }
}

resource "aws_ecs_cluster_capacity_providers" "expenseflow" {
  cluster_name = aws_ecs_cluster.expenseflow.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}

# ====== ALB ======

resource "aws_lb" "expenseflow" {
  #checkov:skip=CKV_AWS_150: ADR-0023 - deletion protection stays off so the local floci dev loop can terraform destroy the stack; revisit for non-local environments.
  #checkov:skip=CKV_AWS_91: ADR-0023 - access logging needs a new S3 bucket this stack does not yet own; deferred follow-up infrastructure work.
  #checkov:skip=CKV2_AWS_20: ADR-0023 - no ACM certificate/domain exists yet in this local stack; HTTPS redirect needs an HTTPS listener first.
  #checkov:skip=CKV2_AWS_28: ADR-0023 - no WAF ACL exists yet in this local stack; floci-only traffic, revisit for non-local environments.
  name = "${var.stack_name}-alb"
  #trivy:ignore:AWS-0053 ADR-0023 - public-facing ALB is intentional for this internet-facing API; no WAF ACL exists yet in this local stack.
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.security_group_id_alb]
  subnets            = var.subnet_ids_public

  enable_deletion_protection       = false
  enable_http2                     = true
  enable_cross_zone_load_balancing = true
  drop_invalid_header_fields       = true

  tags = { Name = "${var.stack_name}-alb" }
}

resource "aws_lb_target_group" "api" {
  #checkov:skip=CKV_AWS_378: ADR-0023 - no ACM certificate/domain exists yet in this local stack; target group protocol follows the HTTP listener until HTTPS is introduced.
  name        = "${var.stack_name}-api-tg"
  port        = var.container_port_api
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    path                = "/health"
    matcher             = "200"
  }

  tags = { Name = "${var.stack_name}-api-tg" }
}

#trivy:ignore:AWS-0054 ADR-0023 - no ACM certificate/domain exists yet in this local stack; adding HTTPS is separate infrastructure work tracked in the ADR.
resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2: ADR-0023 - no ACM certificate/domain exists yet in this local stack; adding HTTPS is separate infrastructure work tracked in the ADR.
  #checkov:skip=CKV_AWS_103: ADR-0023 - see CKV_AWS_2 justification above; TLS policy is moot without an HTTPS listener.
  load_balancer_arn = aws_lb.expenseflow.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# ====== KMS Key for CloudWatch Logs ======

data "aws_iam_policy_document" "logs_key" {
  #checkov:skip=CKV_AWS_356: ADR-0023 - KMS key policy "Resource: *" is self-referential to this key per AWS's documented default key policy pattern, not an unconstrained grant; there is no key ARN to reference without a policy/key cycle.
  #checkov:skip=CKV_AWS_109: ADR-0023 - see CKV_AWS_356 justification above; principal is the account root, not a wildcard identity.
  #checkov:skip=CKV_AWS_111: ADR-0023 - see CKV_AWS_356 justification above; principal is the account root, not a wildcard identity.
  statement {
    sid    = "AllowAccountRootFullAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowCloudWatchLogsUseOfKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logs.${var.aws_region}.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]

    resources = ["*"]
  }
}

resource "aws_kms_key" "logs" {
  description             = "KMS key for CloudWatch Logs encryption in ExpenseFlow."
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.logs_key.json

  tags = { Name = "${var.stack_name}-logs-key" }
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.stack_name}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

# ====== CloudWatch Logs ======

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.stack_name}-api"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.logs.arn

  tags = { Name = "${var.stack_name}-api-logs" }
}

resource "aws_cloudwatch_log_group" "compute" {
  name              = "/ecs/${var.stack_name}-compute"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.logs.arn

  tags = { Name = "${var.stack_name}-compute-logs" }
}

# ====== ECS Task Definitions ======

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.stack_name}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = var.app_task_role_arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.container_image_api
      essential = true
      portMappings = [
        {
          containerPort = var.container_port_api
          hostPort      = var.container_port_api
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
      secrets = [
        {
          name      = "DB_PASSWORD"
          valueFrom = var.db_password_secret_arn
        }
      ]
      environment = [
        {
          name  = "DATABASE_URL"
          value = "postgresql://${var.rds_master_username}@${var.rds_cluster_endpoint}:${var.rds_port}/${var.rds_database_name}"
        },
        {
          name  = "REDIS_URL"
          value = "redis://${var.elasticache_redis_endpoint}:${var.elasticache_redis_port}"
        },
        {
          name  = "SNS_STAGE_EVENTS_TOPIC"
          value = var.sns_stage_events_topic_name
        },
        {
          name  = "SQS_STAGE_EVENTS_QUEUE"
          value = var.sqs_stage_projection_queue_url
        },
        {
          name  = "DYNAMODB_CASE_QUEUE_TABLE"
          value = var.dynamodb_case_queue_rollup_table_name
        }
      ]
    }
  ])

  tags = { Name = "${var.stack_name}-api-taskdef" }
}

resource "aws_ecs_task_definition" "compute" {
  family                   = "${var.stack_name}-compute"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = var.ecs_execution_role_arn
  task_role_arn            = var.app_task_role_arn

  container_definitions = jsonencode([
    {
      name      = "compute"
      image     = var.container_image_compute
      essential = true
      portMappings = [
        {
          containerPort = var.container_port_compute
          hostPort      = var.container_port_compute
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.compute.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
      secrets = [
        {
          name      = "DB_PASSWORD"
          valueFrom = var.db_password_secret_arn
        }
      ]
      environment = [
        {
          name  = "DATABASE_URL"
          value = "postgresql://${var.rds_master_username}@${var.rds_cluster_endpoint}:${var.rds_port}/${var.rds_database_name}"
        },
        {
          name  = "REDIS_URL"
          value = "redis://${var.elasticache_redis_endpoint}:${var.elasticache_redis_port}"
        },
        {
          name  = "SNS_STAGE_EVENTS_TOPIC"
          value = var.sns_stage_events_topic_name
        },
        {
          name  = "SQS_STAGE_EVENTS_QUEUE"
          value = var.sqs_stage_projection_queue_url
        },
        {
          name  = "SQS_STAGE_EVENTS_DLQ"
          value = var.sqs_stage_projection_dlq_url
        },
        {
          name  = "DYNAMODB_IDEMPOTENCY_TABLE"
          value = var.dynamodb_idempotency_table_name
        }
      ]
    }
  ])

  tags = { Name = "${var.stack_name}-compute-taskdef" }
}

# ====== ECS Services ======

resource "aws_ecs_service" "api" {
  name            = "${var.stack_name}-api-service"
  cluster         = aws_ecs_cluster.expenseflow.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids_private_task
    security_groups  = [var.security_group_id_api_task]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.container_port_api
  }

  tags = { Name = "${var.stack_name}-api-service" }

  depends_on = [aws_lb_listener.http]
}

resource "aws_ecs_service" "compute" {
  name            = "${var.stack_name}-compute-service"
  cluster         = aws_ecs_cluster.expenseflow.id
  task_definition = aws_ecs_task_definition.compute.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids_private_task
    security_groups  = [var.security_group_id_compute_task]
    assign_public_ip = false
  }

  tags = { Name = "${var.stack_name}-compute-service" }
}

# ====== Lambda for Deduction Scan ======

resource "aws_lambda_function" "deduction_scan" {
  #checkov:skip=CKV_AWS_50: ADR-0023 - placeholder ZIP with no function code; X-Ray tracing belongs with the real implementation.
  #checkov:skip=CKV_AWS_117: ADR-0023 - placeholder ZIP with no function code; VPC attachment belongs with the real implementation.
  #checkov:skip=CKV_AWS_115: ADR-0023 - placeholder ZIP with no function code; a concurrency limit belongs with the real implementation.
  #checkov:skip=CKV_AWS_173: ADR-0023 - placeholder ZIP with no function code; environment variable KMS encryption belongs with the real implementation.
  #checkov:skip=CKV_AWS_116: ADR-0023 - placeholder ZIP with no function code; a DLQ belongs with the real implementation.
  #checkov:skip=CKV_AWS_272: ADR-0023 - placeholder ZIP with no function code; code-signing belongs with the real implementation.
  filename      = "lambda_deduction_scan_placeholder.zip"
  function_name = "${var.stack_name}-deduction-scan"
  role          = var.lambda_deduction_scan_role_arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"

  environment {
    variables = {
      DATABASE_URL = "postgresql://${var.rds_master_username}@${var.rds_cluster_endpoint}:${var.rds_port}/${var.rds_database_name}"
      REDIS_URL    = "redis://${var.elasticache_redis_endpoint}:${var.elasticache_redis_port}"
    }
  }

  tags = { Name = "${var.stack_name}-deduction-scan-lambda" }
}

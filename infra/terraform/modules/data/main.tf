data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

locals {
  default_tags = {
    Stack = var.stack_name
    Layer = "data"
  }
}

# ====== RDS ======

resource "aws_db_subnet_group" "expenseflow" {
  name       = "${var.stack_name}-db-subnet-group"
  subnet_ids = var.subnet_ids_isolated_db

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-db-subnet-group" }
  )
}

resource "aws_rds_cluster" "expenseflow" {
  cluster_identifier              = "${var.stack_name}-db"
  engine                          = "aurora-postgresql"
  engine_version                  = "15.3"
  database_name                   = "expenseflow"
  master_username                 = "expenseflow"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.rds_secret.arn
  db_subnet_group_name            = aws_db_subnet_group.expenseflow.name
  vpc_security_group_ids          = [var.security_group_id_db]
  backup_retention_period         = 7
  preferred_backup_window         = "03:00-04:00"
  preferred_maintenance_window    = "mon:04:00-mon:05:00"
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.stack_name}-db-final-snapshot"
  enable_http_endpoint            = false
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.rds.arn
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.expenseflow.name

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-aurora-cluster" }
  )
}

resource "aws_rds_cluster_parameter_group" "expenseflow" {
  family      = "aurora-postgresql15"
  name        = "${var.stack_name}-aurora-pg15"
  description = "Aurora PostgreSQL 15 parameter group for ExpenseFlow"

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-aurora-pg15-params" }
  )
}

resource "aws_rds_cluster_instance" "primary" {
  cluster_identifier           = aws_rds_cluster.expenseflow.id
  instance_class               = "db.t4g.small"
  engine                       = aws_rds_cluster.expenseflow.engine
  engine_version               = aws_rds_cluster.expenseflow.engine_version
  publicly_accessible          = false
  performance_insights_enabled = false

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-db-instance-1" }
  )
}

resource "aws_rds_cluster_instance" "secondary" {
  cluster_identifier           = aws_rds_cluster.expenseflow.id
  instance_class               = "db.t4g.small"
  engine                       = aws_rds_cluster.expenseflow.engine
  engine_version               = aws_rds_cluster.expenseflow.engine_version
  publicly_accessible          = false
  performance_insights_enabled = false

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-db-instance-2" }
  )
}

# ====== KMS Keys for RDS ======

resource "aws_kms_key" "rds" {
  description             = "KMS key for RDS storage encryption in ExpenseFlow."
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-rds-key" }
  )
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${var.stack_name}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

resource "aws_kms_key" "rds_secret" {
  description             = "KMS key for RDS secret encryption in ExpenseFlow."
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-rds-secret-key" }
  )
}

resource "aws_kms_alias" "rds_secret" {
  name          = "alias/${var.stack_name}-rds-secret"
  target_key_id = aws_kms_key.rds_secret.key_id
}

# ====== Secrets Manager Secrets ======

resource "aws_secretsmanager_secret" "db_password" {
  name        = "${var.stack_name}/local/db-password"
  description = "Managed database password container for ExpenseFlow."
  kms_key_id  = aws_kms_key.rds_secret.arn

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-db-password" }
  )
}

# ====== DynamoDB ======

resource "aws_dynamodb_table" "case_queue_rollup" {
  name                        = "${var.stack_name}-case-queue-rollup"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "tenant_id"
  range_key                   = "current_stage"
  stream_enabled              = false
  deletion_protection_enabled = true

  attribute {
    name = "tenant_id"
    type = "S"
  }

  attribute {
    name = "current_stage"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-case-queue-rollup" }
  )
}

resource "aws_dynamodb_table" "idempotency" {
  name                        = "${var.stack_name}-idempotency"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "pk"
  stream_enabled              = false
  deletion_protection_enabled = true

  attribute {
    name = "pk"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-idempotency" }
  )
}

# ====== ElastiCache Redis ======

resource "aws_security_group" "cache" {
  name        = "${var.stack_name}-cache-sg"
  description = "Security group for Redis ElastiCache in ExpenseFlow"
  vpc_id      = var.vpc_id

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-cache-sg" }
  )
}

resource "aws_security_group_rule" "cache_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 65535
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.cache.id
}

resource "aws_elasticache_subnet_group" "expenseflow" {
  name       = "${var.stack_name}-cache-subnet-group"
  subnet_ids = var.subnet_ids_isolated_db

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-cache-subnet-group" }
  )
}

resource "aws_elasticache_cluster" "expenseflow" {
  cluster_id               = "${var.stack_name}-redis"
  engine                   = "redis"
  engine_version           = "7.0"
  node_type                = "cache.t4g.micro"
  num_cache_nodes          = 1
  parameter_group_name     = "default.redis7"
  port                     = 6379
  subnet_group_name        = aws_elasticache_subnet_group.expenseflow.name
  security_group_ids       = [aws_security_group.cache.id]
  apply_immediately        = true
  snapshot_retention_limit = 7
  snapshot_window          = "02:00-03:00"

  lifecycle {
    prevent_destroy = true
  }

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-redis-cluster" }
  )
}

# ====== SNS ======

resource "aws_sns_topic" "stage_events" {
  name              = "${var.stack_name}-stage-events"
  kms_master_key_id = "alias/aws/sns"

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-stage-events-topic" }
  )
}

# ====== SQS ======

resource "aws_sqs_queue" "stage_projection_dlq" {
  name                      = "${var.stack_name}-stage-projection-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-stage-projection-dlq" }
  )
}

resource "aws_sqs_queue" "stage_projection" {
  name                       = "${var.stack_name}-stage-projection"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.stage_projection_dlq.arn
    maxReceiveCount     = 3
  })

  tags = merge(
    local.default_tags,
    { Name = "${var.stack_name}-stage-projection-queue" }
  )
}

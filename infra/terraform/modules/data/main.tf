data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# ====== RDS ======

resource "aws_db_subnet_group" "expenseflow" {
  name       = "${var.stack_name}-db-subnet-group"
  subnet_ids = var.subnet_ids_isolated_db

  tags = { Name = "${var.stack_name}-db-subnet-group" }
}

resource "aws_rds_cluster" "expenseflow" {
  #checkov:skip=CKV2_AWS_8: ADR-0023 - an AWS Backup vault/plan is not yet owned by this stack; deferred follow-up infrastructure work alongside RDS operational hardening.
  cluster_identifier                  = "${var.stack_name}-db"
  engine                              = "aurora-postgresql"
  engine_version                      = "15.3"
  database_name                       = "expenseflow"
  master_username                     = "expenseflow"
  manage_master_user_password         = true
  master_user_secret_kms_key_id       = aws_kms_key.rds_secret.arn
  db_subnet_group_name                = aws_db_subnet_group.expenseflow.name
  vpc_security_group_ids              = [var.security_group_id_db]
  backup_retention_period             = 7
  preferred_backup_window             = "03:00-04:00"
  preferred_maintenance_window        = "mon:04:00-mon:05:00"
  deletion_protection                 = true
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${var.stack_name}-db-final-snapshot"
  enable_http_endpoint                = false
  storage_encrypted                   = true
  kms_key_id                          = aws_kms_key.rds.arn
  db_cluster_parameter_group_name     = aws_rds_cluster_parameter_group.expenseflow.name
  copy_tags_to_snapshot               = true
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql"]

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.stack_name}-aurora-cluster" }
}

resource "aws_rds_cluster_parameter_group" "expenseflow" {
  family      = "aurora-postgresql15"
  name        = "${var.stack_name}-aurora-pg15"
  description = "Aurora PostgreSQL 15 parameter group for ExpenseFlow"

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  tags = { Name = "${var.stack_name}-aurora-pg15-params" }
}

resource "aws_rds_cluster_instance" "primary" {
  #checkov:skip=CKV_AWS_118: ADR-0023 - enhanced monitoring needs a dedicated IAM monitoring role wired through the iam module; deferred follow-up infrastructure work.
  cluster_identifier              = aws_rds_cluster.expenseflow.id
  instance_class                  = "db.t4g.small"
  engine                          = aws_rds_cluster.expenseflow.engine
  engine_version                  = aws_rds_cluster.expenseflow.engine_version
  publicly_accessible             = false
  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.rds.arn

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.stack_name}-db-instance-1" }
}

resource "aws_rds_cluster_instance" "secondary" {
  #checkov:skip=CKV_AWS_118: ADR-0023 - enhanced monitoring needs a dedicated IAM monitoring role wired through the iam module; deferred follow-up infrastructure work.
  cluster_identifier              = aws_rds_cluster.expenseflow.id
  instance_class                  = "db.t4g.small"
  engine                          = aws_rds_cluster.expenseflow.engine
  engine_version                  = aws_rds_cluster.expenseflow.engine_version
  publicly_accessible             = false
  auto_minor_version_upgrade      = true
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.rds.arn

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.stack_name}-db-instance-2" }
}

# ====== KMS Keys for RDS ======

data "aws_iam_policy_document" "rds_key" {
  statement {
    sid    = "AllowAccountRootFullAccess"
    effect = "Allow"

    #checkov:skip=CKV_AWS_356: ADR-0023 - KMS key policy "Resource: *" is self-referential to this key per AWS's documented default key policy pattern, not an unconstrained grant; there is no key ARN to reference without a policy/key cycle.
    #checkov:skip=CKV_AWS_109: ADR-0023 - see CKV_AWS_356 justification above; principal is the account root, not a wildcard identity.
    #checkov:skip=CKV_AWS_111: ADR-0023 - see CKV_AWS_356 justification above; principal is the account root, not a wildcard identity.
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowRDSUseOfKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:CreateGrant",
      "kms:DescribeKey",
    ]

    resources = ["*"]
  }
}

resource "aws_kms_key" "rds" {
  description             = "KMS key for RDS storage encryption in ExpenseFlow."
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.rds_key.json

  tags = { Name = "${var.stack_name}-rds-key" }
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${var.stack_name}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

resource "aws_kms_key" "rds_secret" {
  description             = "KMS key for RDS secret encryption in ExpenseFlow."
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.rds_key.json

  tags = { Name = "${var.stack_name}-rds-secret-key" }
}

resource "aws_kms_alias" "rds_secret" {
  name          = "alias/${var.stack_name}-rds-secret"
  target_key_id = aws_kms_key.rds_secret.key_id
}

# ====== Secrets Manager Secrets ======

resource "aws_secretsmanager_secret" "db_password" {
  #checkov:skip=CKV2_AWS_57: ADR-0023 - automatic rotation needs a rotation Lambda this stack does not yet own; deferred follow-up infrastructure work.
  name        = "${var.stack_name}/local/db-password"
  description = "Managed database password container for ExpenseFlow."
  kms_key_id  = aws_kms_key.rds_secret.arn

  tags = { Name = "${var.stack_name}-db-password" }
}

# ====== KMS Key for DynamoDB ======

data "aws_iam_policy_document" "dynamodb_key" {
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
    sid    = "AllowDynamoDBUseOfKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["dynamodb.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
      "kms:CreateGrant",
      "kms:DescribeKey",
    ]

    resources = ["*"]
  }
}

resource "aws_kms_key" "dynamodb" {
  description             = "KMS key for DynamoDB table encryption in ExpenseFlow."
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.dynamodb_key.json

  tags = { Name = "${var.stack_name}-dynamodb-key" }
}

resource "aws_kms_alias" "dynamodb" {
  name          = "alias/${var.stack_name}-dynamodb"
  target_key_id = aws_kms_key.dynamodb.key_id
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

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.dynamodb.arn
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.stack_name}-case-queue-rollup" }
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

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.dynamodb.arn
  }

  lifecycle {
    prevent_destroy = true
  }

  tags = { Name = "${var.stack_name}-idempotency" }
}

# ====== ElastiCache Redis ======

resource "aws_security_group" "cache" {
  name        = "${var.stack_name}-cache-sg"
  description = "Security group for Redis ElastiCache in ExpenseFlow"
  vpc_id      = var.vpc_id

  tags = { Name = "${var.stack_name}-cache-sg" }
}

resource "aws_security_group_rule" "cache_egress" {
  description       = "Redis cache egress scoped to in-VPC traffic only"
  type              = "egress"
  from_port         = 0
  to_port           = 65535
  protocol          = "-1"
  cidr_blocks       = [var.vpc_cidr_block]
  security_group_id = aws_security_group.cache.id
}

resource "aws_elasticache_subnet_group" "expenseflow" {
  name       = "${var.stack_name}-cache-subnet-group"
  subnet_ids = var.subnet_ids_isolated_db

  tags = { Name = "${var.stack_name}-cache-subnet-group" }
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

  tags = { Name = "${var.stack_name}-redis-cluster" }
}

# ====== KMS Key for SNS ======

data "aws_iam_policy_document" "sns_key" {
  statement {
    sid    = "AllowAccountRootFullAccess"
    effect = "Allow"

    #checkov:skip=CKV_AWS_356: ADR-0023 - KMS key policy "Resource: *" is self-referential to this key per AWS's documented default key policy pattern, not an unconstrained grant; there is no key ARN to reference without a policy/key cycle.
    #checkov:skip=CKV_AWS_109: ADR-0023 - see CKV_AWS_356 justification above; principal is the account root, not a wildcard identity.
    #checkov:skip=CKV_AWS_111: ADR-0023 - see CKV_AWS_356 justification above; principal is the account root, not a wildcard identity.
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowSNSUseOfKey"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["sns.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]

    resources = ["*"]
  }
}

resource "aws_kms_key" "sns" {
  description             = "KMS key for SNS topic encryption in ExpenseFlow."
  deletion_window_in_days = 7
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.sns_key.json

  tags = { Name = "${var.stack_name}-sns-key" }
}

resource "aws_kms_alias" "sns" {
  name          = "alias/${var.stack_name}-sns"
  target_key_id = aws_kms_key.sns.key_id
}

# ====== SNS ======

resource "aws_sns_topic" "stage_events" {
  name              = "${var.stack_name}-stage-events"
  kms_master_key_id = aws_kms_key.sns.key_id

  tags = { Name = "${var.stack_name}-stage-events-topic" }
}

# ====== SQS ======

resource "aws_sqs_queue" "stage_projection_dlq" {
  name                      = "${var.stack_name}-stage-projection-dlq"
  message_retention_seconds = 1209600 # 14 days
  sqs_managed_sse_enabled   = true

  tags = { Name = "${var.stack_name}-stage-projection-dlq" }
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

  tags = { Name = "${var.stack_name}-stage-projection-queue" }
}

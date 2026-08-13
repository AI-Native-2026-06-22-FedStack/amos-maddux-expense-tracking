module "network" {
  source = "./modules/network"

  stack_name         = var.stack_name
  aws_region         = var.aws_region
  floci_endpoint_url = var.floci_endpoint_url
  shared_zone_name   = var.shared_zone_name
}

module "iam" {
  source = "./modules/iam"

  stack_name = var.stack_name
  aws_region = var.aws_region
}

module "data" {
  source = "./modules/data"

  stack_name             = var.stack_name
  aws_region             = var.aws_region
  vpc_id                 = module.network.vpc_id
  vpc_cidr_block         = module.network.vpc_cidr_block
  subnet_ids_isolated_db = module.network.subnet_ids_by_tier["isolated_db"]
  security_group_id_db   = module.network.security_group_ids["db"]
}

module "app" {
  source = "./modules/app"

  stack_name                            = var.stack_name
  aws_region                            = var.aws_region
  vpc_id                                = module.network.vpc_id
  subnet_ids_public                     = module.network.subnet_ids_by_tier["public"]
  subnet_ids_private_task               = module.network.subnet_ids_by_tier["private_task"]
  security_group_id_alb                 = module.network.security_group_ids["alb"]
  security_group_id_api_task            = module.network.security_group_ids["api_task"]
  security_group_id_compute_task        = module.network.security_group_ids["compute_task"]
  ecs_execution_role_arn                = module.iam.ecs_execution_role_arn
  ecs_execution_role_name               = module.iam.ecs_execution_role_name
  app_task_role_arn                     = module.iam.app_task_role_arn
  app_task_role_name                    = module.iam.app_task_role_name
  lambda_deduction_scan_role_arn        = module.iam.lambda_deduction_scan_role_arn
  rds_cluster_endpoint                  = module.data.rds_cluster_endpoint
  rds_database_name                     = module.data.rds_database_name
  rds_port                              = module.data.rds_port
  rds_master_username                   = module.data.rds_master_username
  db_password_secret_arn                = module.data.db_password_secret_arn
  dynamodb_case_queue_rollup_table_name = module.data.dynamodb_case_queue_rollup_table_name
  dynamodb_idempotency_table_name       = module.data.dynamodb_idempotency_table_name
  elasticache_redis_endpoint            = module.data.elasticache_redis_endpoint
  elasticache_redis_port                = module.data.elasticache_redis_port
  sns_stage_events_topic_arn            = module.data.sns_stage_events_topic_arn
  sns_stage_events_topic_name           = module.data.sns_stage_events_topic_name
  sqs_stage_projection_queue_url        = module.data.sqs_stage_projection_queue_url
  sqs_stage_projection_queue_arn        = module.data.sqs_stage_projection_queue_arn
  sqs_stage_projection_dlq_url          = module.data.sqs_stage_projection_dlq_url
}

module "observability" {
  source = "./modules/observability"

  stack_name                   = var.stack_name
  aws_region                   = var.aws_region
  ecs_cluster_name             = module.app.ecs_cluster_name
  ecs_cluster_arn              = module.app.ecs_cluster_arn
  api_service_name             = module.app.api_service_name
  api_service_arn              = module.app.api_service_arn
  compute_service_name         = module.app.compute_service_name
  compute_service_arn          = module.app.compute_service_arn
  alb_arn                      = module.app.alb_arn
  api_cloudwatch_log_group     = module.app.api_cloudwatch_log_group
  compute_cloudwatch_log_group = module.app.compute_cloudwatch_log_group
}

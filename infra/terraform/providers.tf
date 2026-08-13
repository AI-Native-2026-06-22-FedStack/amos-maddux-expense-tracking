terraform {
  required_version = ">= 1.15.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "6.50.0"
    }
  }
}

provider "aws" {
  region                      = var.aws_region
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    dynamodb             = var.floci_endpoint_url
    ec2                  = var.floci_endpoint_url
    ecs                  = var.floci_endpoint_url
    elasticache          = var.floci_endpoint_url
    elasticloadbalancing = var.floci_endpoint_url
    elbv2                = var.floci_endpoint_url
    iam                  = var.floci_endpoint_url
    kms                  = var.floci_endpoint_url
    lambda               = var.floci_endpoint_url
    logs                 = var.floci_endpoint_url
    rds                  = var.floci_endpoint_url
    route53              = var.floci_endpoint_url
    s3                   = var.floci_endpoint_url
    secretsmanager       = var.floci_endpoint_url
    sns                  = var.floci_endpoint_url
    sqs                  = var.floci_endpoint_url
    sts                  = var.floci_endpoint_url
  }
}

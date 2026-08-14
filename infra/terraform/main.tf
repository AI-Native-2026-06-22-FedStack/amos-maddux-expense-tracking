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

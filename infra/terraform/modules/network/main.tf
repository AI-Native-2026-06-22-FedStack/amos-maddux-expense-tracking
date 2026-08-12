variable "stack_name" {
  description = "Name prefix for ExpenseFlow network resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region modeled by local floci."
  type        = string
}

variable "floci_endpoint_url" {
  description = "Host-side endpoint URL for local floci AWS APIs."
  type        = string
}

variable "shared_zone_name" {
  description = "Optional pre-existing Route53 hosted zone name to read, not manage."
  type        = string
  default     = null
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_route53_zone" "shared" {
  count = var.shared_zone_name == null ? 0 : 1

  name         = var.shared_zone_name
  private_zone = false
}

locals {
  az_names = slice(data.aws_availability_zones.available.names, 0, 2)

  subnets = {
    public_a = {
      name                    = "${var.stack_name}-public-a"
      cidr_block              = "10.42.0.0/24"
      availability_zone       = local.az_names[0]
      tier                    = "public"
      map_public_ip_on_launch = false
    }
    public_b = {
      name                    = "${var.stack_name}-public-b"
      cidr_block              = "10.42.1.0/24"
      availability_zone       = local.az_names[1]
      tier                    = "public"
      map_public_ip_on_launch = false
    }
    task_a = {
      name                    = "${var.stack_name}-task-a"
      cidr_block              = "10.42.10.0/24"
      availability_zone       = local.az_names[0]
      tier                    = "private-task"
      map_public_ip_on_launch = false
    }
    task_b = {
      name                    = "${var.stack_name}-task-b"
      cidr_block              = "10.42.11.0/24"
      availability_zone       = local.az_names[1]
      tier                    = "private-task"
      map_public_ip_on_launch = false
    }
    db_a = {
      name                    = "${var.stack_name}-db-a"
      cidr_block              = "10.42.20.0/24"
      availability_zone       = local.az_names[0]
      tier                    = "isolated-db"
      map_public_ip_on_launch = false
    }
    db_b = {
      name                    = "${var.stack_name}-db-b"
      cidr_block              = "10.42.21.0/24"
      availability_zone       = local.az_names[1]
      tier                    = "isolated-db"
      map_public_ip_on_launch = false
    }
  }

  public_subnet_keys = ["public_a", "public_b"]
  task_subnet_keys   = ["task_a", "task_b"]
  db_subnet_keys     = ["db_a", "db_b"]

  route_table_associations = {
    public_a = {
      subnet_id      = aws_subnet.expenseflow["public_a"].id
      route_table_id = aws_route_table.public.id
    }
    public_b = {
      subnet_id      = aws_subnet.expenseflow["public_b"].id
      route_table_id = aws_route_table.public.id
    }
    task_a = {
      subnet_id      = aws_subnet.expenseflow["task_a"].id
      route_table_id = aws_route_table.task.id
    }
    task_b = {
      subnet_id      = aws_subnet.expenseflow["task_b"].id
      route_table_id = aws_route_table.task.id
    }
    db_a = {
      subnet_id      = aws_subnet.expenseflow["db_a"].id
      route_table_id = aws_route_table.db.id
    }
    db_b = {
      subnet_id      = aws_subnet.expenseflow["db_b"].id
      route_table_id = aws_route_table.db.id
    }
  }

  security_group_rule_commands = {
    alb_http = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-ingress --group-id ${aws_security_group.alb.id} --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null || true"

    api_from_alb = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-ingress --group-id ${aws_security_group.api_task.id} --protocol tcp --port 3000 --source-group ${aws_security_group.alb.id} >/dev/null || true"

    compute_from_api = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-ingress --group-id ${aws_security_group.compute_task.id} --protocol tcp --port 8000 --source-group ${aws_security_group.api_task.id} >/dev/null || true"

    db_from_api = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-ingress --group-id ${aws_security_group.db.id} --protocol tcp --port 5432 --source-group ${aws_security_group.api_task.id} >/dev/null || true"

    db_from_compute = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-ingress --group-id ${aws_security_group.db.id} --protocol tcp --port 5432 --source-group ${aws_security_group.compute_task.id} >/dev/null || true"

    alb_egress = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-egress --group-id ${aws_security_group.alb.id} --protocol -1 --cidr 0.0.0.0/0 >/dev/null || true"

    api_egress = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-egress --group-id ${aws_security_group.api_task.id} --protocol -1 --cidr 0.0.0.0/0 >/dev/null || true"

    compute_egress = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-egress --group-id ${aws_security_group.compute_task.id} --protocol -1 --cidr 0.0.0.0/0 >/dev/null || true"

    db_egress = "aws --endpoint-url \"$AWS_ENDPOINT_URL\" --region \"$AWS_REGION\" ec2 authorize-security-group-egress --group-id ${aws_security_group.db.id} --protocol -1 --cidr 0.0.0.0/0 >/dev/null || true"
  }
}

resource "aws_vpc" "expenseflow" {
  #checkov:skip=CKV2_AWS_11: ADR-0023 - floci 1.5.11 rejects CreateFlowLogs; enable VPC flow logs in real AWS.
  #checkov:skip=CKV2_AWS_12: ADR-0023 - floci 1.5.11 returns an empty default security group read; restrict the default SG in real AWS.
  cidr_block           = "10.42.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.stack_name}-vpc"
  }
}

resource "aws_subnet" "expenseflow" {
  for_each = local.subnets

  vpc_id                  = aws_vpc.expenseflow.id
  cidr_block              = each.value.cidr_block
  availability_zone       = each.value.availability_zone
  map_public_ip_on_launch = each.value.map_public_ip_on_launch

  tags = {
    Name = each.value.name
    Tier = each.value.tier
  }
}

resource "aws_internet_gateway" "expenseflow" {
  vpc_id = aws_vpc.expenseflow.id

  tags = {
    Name = "${var.stack_name}-igw"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.expenseflow.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.expenseflow.id
  }

  tags = {
    Name = "${var.stack_name}-public-rt"
    Tier = "public"
  }
}

resource "aws_route_table" "task" {
  vpc_id = aws_vpc.expenseflow.id

  tags = {
    Name = "${var.stack_name}-task-rt"
    Tier = "private-task"
  }
}

resource "aws_route_table" "db" {
  vpc_id = aws_vpc.expenseflow.id

  tags = {
    Name = "${var.stack_name}-db-rt"
    Tier = "isolated-db"
  }
}

resource "terraform_data" "route_table_association" {
  for_each = local.route_table_associations

  input = {
    subnet_id      = each.value.subnet_id
    route_table_id = each.value.route_table_id
  }

  provisioner "local-exec" {
    command = <<-EOT
      aws --endpoint-url "$AWS_ENDPOINT_URL" --region "$AWS_REGION" ec2 associate-route-table --subnet-id "$SUBNET_ID" --route-table-id "$ROUTE_TABLE_ID" >/dev/null || true
    EOT

    environment = {
      AWS_ACCESS_KEY_ID     = "test"
      AWS_SECRET_ACCESS_KEY = "test"
      AWS_ENDPOINT_URL      = var.floci_endpoint_url
      AWS_REGION            = var.aws_region
      ROUTE_TABLE_ID        = each.value.route_table_id
      SUBNET_ID             = each.value.subnet_id
    }
  }
}

resource "aws_security_group" "alb" {
  #checkov:skip=CKV2_AWS_5: ADR-0023 - base module exports this SG before the ALB module consumes it; attach in workload modules.
  name        = "${var.stack_name}-alb-sg"
  description = "Internet-facing ALB entry point for ExpenseFlow"
  vpc_id      = aws_vpc.expenseflow.id

  tags = {
    Name = "${var.stack_name}-alb-sg"
  }
}

resource "aws_security_group" "api_task" {
  #checkov:skip=CKV2_AWS_5: ADR-0023 - base module exports this SG before the ECS service module consumes it; attach in workload modules.
  name        = "${var.stack_name}-api-task-sg"
  description = "Private Core Case Service task ingress from the ALB only"
  vpc_id      = aws_vpc.expenseflow.id

  tags = {
    Name = "${var.stack_name}-api-task-sg"
  }
}

resource "aws_security_group" "compute_task" {
  #checkov:skip=CKV2_AWS_5: ADR-0023 - base module exports this SG before the ECS service module consumes it; attach in workload modules.
  name        = "${var.stack_name}-compute-task-sg"
  description = "Private GL-coding engine ingress from the API task only"
  vpc_id      = aws_vpc.expenseflow.id

  tags = {
    Name = "${var.stack_name}-compute-task-sg"
  }
}

resource "aws_security_group" "db" {
  #checkov:skip=CKV2_AWS_5: ADR-0023 - base module exports this SG before the database module consumes it; attach in workload modules.
  name        = "${var.stack_name}-db-sg"
  description = "Private Postgres ingress from application tasks only"
  vpc_id      = aws_vpc.expenseflow.id

  tags = {
    Name = "${var.stack_name}-db-sg"
  }
}

resource "terraform_data" "security_group_rule" {
  for_each = local.security_group_rule_commands

  input = each.value

  provisioner "local-exec" {
    command = each.value

    environment = {
      AWS_ACCESS_KEY_ID     = "test"
      AWS_SECRET_ACCESS_KEY = "test"
      AWS_ENDPOINT_URL      = var.floci_endpoint_url
      AWS_REGION            = var.aws_region
    }
  }
}

output "vpc_id" {
  description = "ID of the ExpenseFlow VPC."
  value       = aws_vpc.expenseflow.id
}

output "subnet_ids_by_tier" {
  description = "Subnet IDs grouped by network tier."
  value = {
    public       = [for key in local.public_subnet_keys : aws_subnet.expenseflow[key].id]
    private_task = [for key in local.task_subnet_keys : aws_subnet.expenseflow[key].id]
    isolated_db  = [for key in local.db_subnet_keys : aws_subnet.expenseflow[key].id]
  }
}

output "security_group_ids" {
  description = "Security group IDs keyed by purpose."
  value = {
    alb          = aws_security_group.alb.id
    api_task     = aws_security_group.api_task.id
    compute_task = aws_security_group.compute_task.id
    db           = aws_security_group.db.id
  }
}

output "shared_zone" {
  description = "Optional externally owned Route53 hosted zone."
  value = var.shared_zone_name == null ? null : {
    id   = data.aws_route53_zone.shared[0].zone_id
    name = data.aws_route53_zone.shared[0].name
  }
}

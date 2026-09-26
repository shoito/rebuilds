# Environment VPC: three AZs with public, private and isolated subnets
# (REQ-INFRA-010, DT-INFRA-004), VPC endpoints (REQ-INFRA-011) and flow logs to
# log-archive (REQ-INFRA-012). No IPv6 is assigned, so no ::/0 route can exist.

data "aws_region" "current" {}

locals {
  azs = var.availability_zones

  # /20 subnets: public 0-2, private 3-5, isolated 6-8.
  subnet_cidrs = {
    public   = { for i, az in local.azs : az => cidrsubnet(var.cidr_block, 4, i) }
    private  = { for i, az in local.azs : az => cidrsubnet(var.cidr_block, 4, 3 + i) }
    isolated = { for i, az in local.azs : az => cidrsubnet(var.cidr_block, 4, 6 + i) }
  }

  # AZs that get a NAT gateway: all AZs, a single AZ (dev) or none (standby).
  nat_azs = var.standby ? [] : (var.nat_per_az ? local.azs : [local.azs[0]])

  # NAT used by the private subnet of each AZ (DT-INFRA-004 #2 and #3).
  private_nat_az = var.standby ? {} : { for az in local.azs : az => (var.nat_per_az ? az : local.azs[0]) }

  interface_endpoints = var.standby ? [] : var.interface_endpoint_services
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = var.name }
}

# Deny everything on the default security group; workloads use their own groups.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-default-deny" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = { Name = var.name }
}

resource "aws_subnet" "public" {
  for_each = local.subnet_cidrs.public

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = { Name = "${var.name}-public-${each.key}", Tier = "public" }
}

resource "aws_subnet" "private" {
  for_each = local.subnet_cidrs.private

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = { Name = "${var.name}-private-${each.key}", Tier = "private" }
}

resource "aws_subnet" "isolated" {
  for_each = local.subnet_cidrs.isolated

  vpc_id            = aws_vpc.this.id
  availability_zone = each.key
  cidr_block        = each.value

  tags = { Name = "${var.name}-isolated-${each.key}", Tier = "isolated" }
}

# --- Public: 0.0.0.0/0 -> Internet Gateway (DT-INFRA-004 #1).

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  for_each = toset(local.nat_azs)

  domain = "vpc"

  tags = { Name = "${var.name}-nat-${each.key}" }
}

resource "aws_nat_gateway" "this" {
  for_each = toset(local.nat_azs)

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = { Name = "${var.name}-nat-${each.key}" }

  depends_on = [aws_internet_gateway.this]
}

# --- Private: one route table per AZ; 0.0.0.0/0 -> NAT in the same AZ (#2), none when standby (#3).

resource "aws_route_table" "private" {
  for_each = toset(local.azs)

  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-private-${each.key}" }
}

resource "aws_route" "private_nat" {
  for_each = local.private_nat_az

  route_table_id         = aws_route_table.private[each.key].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.this[each.value].id
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

# --- Isolated: no default route at all (#4); only local and the S3 gateway endpoint.

resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.this.id

  tags = { Name = "${var.name}-isolated" }
}

resource "aws_route_table_association" "isolated" {
  for_each = aws_subnet.isolated

  subnet_id      = each.value.id
  route_table_id = aws_route_table.isolated.id
}

# --- Endpoints (REQ-INFRA-011). S3 gateway endpoint on every route table (DT-INFRA-004).

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = concat(
    [aws_route_table.public.id, aws_route_table.isolated.id],
    [for az in local.azs : aws_route_table.private[az].id],
  )

  tags = { Name = "${var.name}-s3" }
}

resource "aws_security_group" "endpoints" {
  #checkov:skip=CKV2_AWS_5:attached to every aws_vpc_endpoint.interface (for_each is not resolved by Checkov) approved-by:PENDING
  count = length(local.interface_endpoints) > 0 ? 1 : 0

  name        = "${var.name}-vpc-endpoints"
  description = "HTTPS from inside the VPC to interface endpoints"
  vpc_id      = aws_vpc.this.id

  tags = { Name = "${var.name}-vpc-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count = length(local.interface_endpoints) > 0 ? 1 : 0

  security_group_id = aws_security_group.endpoints[0].id
  description       = "HTTPS from the VPC CIDR only"
  cidr_ipv4         = var.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each = toset(local.interface_endpoints)

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${data.aws_region.current.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = [for az in local.azs : aws_subnet.private[az].id]
  security_group_ids  = [aws_security_group.endpoints[0].id]

  tags = { Name = "${var.name}-${each.key}" }
}

# --- Flow logs: accepted and rejected traffic to log-archive (REQ-INFRA-012).

resource "aws_flow_log" "this" {
  vpc_id                   = aws_vpc.this.id
  traffic_type             = "ALL"
  log_destination_type     = "s3"
  log_destination          = "${var.flow_log_bucket_arn}/vpc/"
  max_aggregation_interval = 600

  destination_options {
    file_format                = "parquet"
    per_hour_partition         = true
    hive_compatible_partitions = true
  }

  tags = { Name = var.name }
}

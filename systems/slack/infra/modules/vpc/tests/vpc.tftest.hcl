# Module tests for vpc (REQ-INFRA-010, REQ-INFRA-011, REQ-INFRA-012, DT-INFRA-004, REQ-INFRA-018).
# Each DT-INFRA-004 row has its own run block. Runs apply against the mock
# provider (no AWS calls) so that generated IDs can be compared.

mock_provider "aws" {
  mock_data "aws_region" {
    defaults = {
      region = "ap-northeast-1"
    }
  }
}

variables {
  name                = "slack-prod"
  cidr_block          = "10.30.0.0/16"
  availability_zones  = ["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"]
  flow_log_bucket_arn = "arn:aws:s3:::slack-flowlogs-123456789012-ap-northeast-1"
}

run "req_infra_010_nine_subnets_across_three_azs" {
  assert {
    condition = alltrue([
      for tier in [aws_subnet.public, aws_subnet.private, aws_subnet.isolated] :
      toset([for s in tier : s.availability_zone]) == toset(["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"])
    ])
    error_message = "REQ-INFRA-010: public, private and isolated must each have one subnet in 1a, 1c and 1d."
  }

  assert {
    condition     = length(aws_subnet.public) + length(aws_subnet.private) + length(aws_subnet.isolated) == 9
    error_message = "REQ-INFRA-010: the VPC must have exactly 9 subnets."
  }

  assert {
    condition = alltrue([
      for s in concat(values(aws_subnet.public), values(aws_subnet.private), values(aws_subnet.isolated)) :
      endswith(s.cidr_block, "/20")
    ])
    error_message = "REQ-INFRA-010: every subnet is a /20."
  }
}

run "dt_infra_004_row1_public_default_route_to_internet_gateway" {
  assert {
    condition = (
      aws_route.public_internet.destination_cidr_block == "0.0.0.0/0" &&
      aws_route.public_internet.gateway_id == aws_internet_gateway.this.id &&
      aws_route.public_internet.route_table_id == aws_route_table.public.id
    )
    error_message = "DT-INFRA-004 #1: public 0.0.0.0/0 must go to the Internet Gateway."
  }

  assert {
    condition     = contains(aws_vpc_endpoint.s3.route_table_ids, aws_route_table.public.id)
    error_message = "DT-INFRA-004 #1: public route table must have the S3 gateway endpoint."
  }
}

run "dt_infra_004_row2_private_default_route_to_nat_in_same_az" {
  assert {
    condition     = length(aws_nat_gateway.this) == 3
    error_message = "DT-INFRA-004 #2: one NAT gateway per AZ when nat_per_az = true."
  }

  assert {
    condition = alltrue([
      for az in ["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"] :
      aws_route.private_nat[az].route_table_id == aws_route_table.private[az].id &&
      aws_route.private_nat[az].destination_cidr_block == "0.0.0.0/0" &&
      aws_route.private_nat[az].nat_gateway_id == aws_nat_gateway.this[az].id &&
      aws_nat_gateway.this[az].subnet_id == aws_subnet.public[az].id
    ])
    error_message = "DT-INFRA-004 #2 / REQ-INFRA-010: the private subnet of each AZ must use the NAT gateway in the public subnet of the same AZ."
  }

  assert {
    condition     = alltrue([for az, rt in aws_route_table.private : contains(aws_vpc_endpoint.s3.route_table_ids, rt.id)])
    error_message = "DT-INFRA-004 #2: private route tables must have the S3 gateway endpoint."
  }
}

run "dt_infra_004_row3_standby_private_has_no_default_route" {
  variables {
    name                = "slack-prod-osaka"
    cidr_block          = "10.31.0.0/16"
    availability_zones  = ["ap-northeast-3a", "ap-northeast-3b", "ap-northeast-3c"]
    standby             = true
    flow_log_bucket_arn = "arn:aws:s3:::slack-flowlogs-123456789012-ap-northeast-3"
  }

  assert {
    condition     = length(aws_route.private_nat) == 0 && length(aws_nat_gateway.this) == 0 && length(aws_eip.nat) == 0
    error_message = "DT-INFRA-004 #3: a standby VPC has no NAT gateway and no private default route."
  }

  assert {
    condition     = alltrue([for az, rt in aws_route_table.private : contains(aws_vpc_endpoint.s3.route_table_ids, rt.id)])
    error_message = "DT-INFRA-004 #3: standby private route tables still have the S3 gateway endpoint."
  }

  assert {
    condition     = length(aws_vpc_endpoint.interface) == 0 && length(aws_security_group.endpoints) == 0
    error_message = "Spec Design: the standby VPC has no interface endpoints until failover."
  }

  assert {
    condition     = length(aws_subnet.public) + length(aws_subnet.private) + length(aws_subnet.isolated) == 9
    error_message = "REQ-INFRA-010: the standby VPC still has 9 subnets across 3 AZs."
  }
}

run "dt_infra_004_row4_isolated_has_no_default_route" {
  assert {
    condition = length([
      for r in concat([aws_route.public_internet], values(aws_route.private_nat)) :
      r if r.route_table_id == aws_route_table.isolated.id
    ]) == 0
    error_message = "DT-INFRA-004 #4 / REQ-INFRA-010: isolated subnets must have no 0.0.0.0/0 or ::/0 route."
  }

  assert {
    condition     = contains(aws_vpc_endpoint.s3.route_table_ids, aws_route_table.isolated.id)
    error_message = "DT-INFRA-004 #4: the isolated route table has the S3 gateway endpoint."
  }

  assert {
    condition     = alltrue([for s in aws_subnet.isolated : s.assign_ipv6_address_on_creation != true]) && aws_vpc.this.assign_generated_ipv6_cidr_block != true
    error_message = "REQ-INFRA-010: no IPv6, so no ::/0 route can exist."
  }
}

run "dt_infra_004_row2_dev_single_nat_shared_by_all_private_subnets" {
  variables {
    name       = "slack-dev"
    cidr_block = "10.10.0.0/16"
    nat_per_az = false
  }

  assert {
    condition     = keys(aws_nat_gateway.this) == ["ap-northeast-1a"]
    error_message = "Spec Design: dev has a single NAT gateway (nat_per_az = false)."
  }

  assert {
    condition     = alltrue([for az, r in aws_route.private_nat : r.nat_gateway_id == aws_nat_gateway.this["ap-northeast-1a"].id])
    error_message = "Spec Design: with nat_per_az = false every private subnet uses the single NAT."
  }
}

run "req_infra_011_interface_endpoints_with_private_dns_and_https_from_vpc_only" {
  assert {
    condition = toset(keys(aws_vpc_endpoint.interface)) == toset([
      "ecr.api", "ecr.dkr", "sqs", "secretsmanager", "kms", "logs", "sts", "xray", "appconfig", "appconfigdata",
    ])
    error_message = "REQ-INFRA-011: all required interface endpoints must exist."
  }

  assert {
    condition     = alltrue([for e in aws_vpc_endpoint.interface : e.private_dns_enabled && e.vpc_endpoint_type == "Interface"])
    error_message = "REQ-INFRA-011: interface endpoints must enable private DNS."
  }

  assert {
    condition     = aws_vpc_endpoint.s3.vpc_endpoint_type == "Gateway" && aws_vpc_endpoint.s3.service_name == "com.amazonaws.ap-northeast-1.s3"
    error_message = "REQ-INFRA-011: S3 must use a gateway endpoint."
  }

  assert {
    condition = (
      length(aws_vpc_security_group_ingress_rule.endpoints_https) == 1 &&
      aws_vpc_security_group_ingress_rule.endpoints_https[0].cidr_ipv4 == "10.30.0.0/16" &&
      aws_vpc_security_group_ingress_rule.endpoints_https[0].from_port == 443 &&
      aws_vpc_security_group_ingress_rule.endpoints_https[0].to_port == 443 &&
      aws_vpc_security_group_ingress_rule.endpoints_https[0].ip_protocol == "tcp"
    )
    error_message = "REQ-INFRA-011: the endpoint security group allows only 443 from the VPC CIDR."
  }
}

run "req_infra_012_flow_logs_all_traffic_to_log_archive" {
  assert {
    condition = (
      aws_flow_log.this.traffic_type == "ALL" &&
      aws_flow_log.this.log_destination_type == "s3" &&
      startswith(aws_flow_log.this.log_destination, "arn:aws:s3:::slack-flowlogs-123456789012-ap-northeast-1/")
    )
    error_message = "REQ-INFRA-012: flow logs must record accepted and rejected traffic to the log-archive bucket."
  }
}

run "req_infra_010_rejects_two_availability_zones" {
  command = plan

  variables {
    availability_zones = ["ap-northeast-1a", "ap-northeast-1c"]
  }

  expect_failures = [var.availability_zones]
}

run "req_infra_010_rejects_non_slash16_cidr" {
  command = plan

  variables {
    cidr_block = "10.30.0.0/20"
  }

  expect_failures = [var.cidr_block]
}

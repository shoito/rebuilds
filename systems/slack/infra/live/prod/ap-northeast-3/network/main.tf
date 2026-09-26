# Standby VPC for disaster recovery: no NAT gateways and no interface endpoints
# until failover (apply with standby = false, then apply compute).
# Must not depend on Tokyo (REQ-INFRA-009, PROP-INFRA-002).
module "vpc" {
  source = "../../../../modules/vpc"

  name                = "slack-prod-osaka"
  cidr_block          = "10.31.0.0/16"
  availability_zones  = ["ap-northeast-3a", "ap-northeast-3b", "ap-northeast-3c"]
  standby             = true
  flow_log_bucket_arn = "arn:aws:s3:::slack-flowlogs-${var.account_ids["log-archive"]}-ap-northeast-3"
}

# Values for later root modules (compute, data) go through SSM Parameter Store (ADR-0020).
resource "aws_ssm_parameter" "vpc_id" {
  name  = "/slack/network/vpc-id"
  type  = "String"
  value = module.vpc.vpc_id
}

resource "aws_ssm_parameter" "private_subnet_ids" {
  name  = "/slack/network/private-subnet-ids"
  type  = "StringList"
  value = join(",", values(module.vpc.private_subnet_ids))
}

resource "aws_ssm_parameter" "isolated_subnet_ids" {
  name  = "/slack/network/isolated-subnet-ids"
  type  = "StringList"
  value = join(",", values(module.vpc.isolated_subnet_ids))
}

resource "aws_ssm_parameter" "public_subnet_ids" {
  name  = "/slack/network/public-subnet-ids"
  type  = "StringList"
  value = join(",", values(module.vpc.public_subnet_ids))
}

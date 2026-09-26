module "vpc" {
  source = "../../../../modules/vpc"

  name                = "slack-staging"
  cidr_block          = "10.20.0.0/16"
  availability_zones  = ["ap-northeast-1a", "ap-northeast-1c", "ap-northeast-1d"]
  flow_log_bucket_arn = "arn:aws:s3:::slack-flowlogs-${var.account_ids["log-archive"]}-ap-northeast-1"
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

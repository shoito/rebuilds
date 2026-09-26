# REQ-INFRA-009 fixture: the Osaka root reads a value from the Tokyo Parameter Store.
terraform {
  backend "s3" {
    key          = "prod/ap-northeast-3/network/terraform.tfstate"
    region       = "ap-northeast-3"
    use_lockfile = true
  }
}

provider "aws" {
  region = "ap-northeast-3"
}

provider "aws" {
  alias  = "tokyo"
  region = "ap-northeast-1"
}

data "aws_ssm_parameter" "vpc_id" {
  provider = aws.tokyo
  name     = "/slack/network/vpc_id"
}

terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Partial configuration: the bucket is passed with -backend-config (DT-INFRA-003).
  backend "s3" {
    key          = "staging/ap-northeast-1/network/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}

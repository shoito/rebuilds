terraform {
  required_version = ">= 1.11.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # Partial configuration: the bucket (slack-tfstate-<account_id>-<region>) is
  # passed with -backend-config by CI (tools/src/root-context.ts), DT-INFRA-003.
  backend "s3" {
    key          = "shared/ap-northeast-1/bootstrap/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}

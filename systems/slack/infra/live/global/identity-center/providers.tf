locals {
  management_id       = var.account_ids["management"]
  allowed_account_ids = local.management_id == null ? null : [local.management_id]
}

# IAM Identity Center is enabled in the management account in ap-northeast-1
# (a console step of the bootstrap, infra/README.md).
provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = { System = "slack", ManagedBy = "terraform", Root = "global/identity-center" }
  }
}

locals {
  account_id          = var.account_ids["dev"]
  allowed_account_ids = local.account_id == null ? null : [local.account_id]
  tags                = { System = "slack", ManagedBy = "terraform", Root = "dev/ap-northeast-1/bootstrap" }
}

provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = local.tags
  }
}

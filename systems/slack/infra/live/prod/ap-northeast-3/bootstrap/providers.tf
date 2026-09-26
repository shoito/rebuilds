locals {
  account_id          = var.account_ids["prod"]
  allowed_account_ids = local.account_id == null ? null : [local.account_id]
  tags                = { System = "slack", ManagedBy = "terraform", Root = "prod/ap-northeast-3/bootstrap" }
}

provider "aws" {
  region              = "ap-northeast-3"
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = local.tags
  }
}

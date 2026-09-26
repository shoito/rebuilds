locals {
  account_id          = var.account_ids["prod"]
  allowed_account_ids = local.account_id == null ? null : [local.account_id]
}

provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = { System = "slack", ManagedBy = "terraform", Root = "prod/ap-northeast-1/network" }
  }
}

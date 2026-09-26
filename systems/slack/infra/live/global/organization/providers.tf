locals {
  management_id       = var.account_ids["management"]
  log_archive_id      = var.account_ids["log-archive"]
  allowed_account_ids = local.management_id == null ? null : [local.management_id]
}

provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = { System = "slack", ManagedBy = "terraform", Root = "global/organization" }
  }
}

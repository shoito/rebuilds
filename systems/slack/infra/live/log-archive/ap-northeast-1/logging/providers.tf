locals {
  account_id          = var.account_ids["log-archive"]
  management_id       = var.account_ids["management"]
  organization_id     = var.organization_id
  allowed_account_ids = local.account_id == null ? null : [local.account_id]
  tags                = { System = "slack", ManagedBy = "terraform", Root = "log-archive/ap-northeast-1/logging" }
}

provider "aws" {
  region              = "ap-northeast-1"
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = local.tags
  }
}

# Flow logs of the Osaka VPC stay in Osaka so that the DR network does not
# depend on Tokyo (REQ-INFRA-009, REQ-INFRA-012).
provider "aws" {
  alias               = "osaka"
  region              = "ap-northeast-3"
  allowed_account_ids = local.allowed_account_ids

  default_tags {
    tags = local.tags
  }
}

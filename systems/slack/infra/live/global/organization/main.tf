# AWS Organizations, OUs and member accounts (REQ-INFRA-001).
# The management account is the organization's own account under Root and
# holds no workloads (enforced by DT-INFRA-007 #4).

resource "aws_organizations_organization" "this" {
  feature_set = "ALL"

  aws_service_access_principals = [
    "cloudtrail.amazonaws.com",
    "sso.amazonaws.com",
    "account.amazonaws.com",
  ]

  enabled_policy_types = ["SERVICE_CONTROL_POLICY"]

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  root_id = aws_organizations_organization.this.roots[0].id

  # infrastructure.md section 1: account -> OU.
  account_ous = {
    security      = "security"
    "log-archive" = "security"
    shared        = "infrastructure"
    dev           = "nonprod"
    staging       = "nonprod"
    prod          = "prod"
  }

  ou_ids = {
    security       = aws_organizations_organizational_unit.security.id
    infrastructure = aws_organizations_organizational_unit.infrastructure.id
    workloads      = aws_organizations_organizational_unit.workloads.id
    nonprod        = aws_organizations_organizational_unit.nonprod.id
    prod           = aws_organizations_organizational_unit.prod.id
  }
}

resource "aws_organizations_organizational_unit" "security" {
  name      = "Security"
  parent_id = local.root_id
}

resource "aws_organizations_organizational_unit" "infrastructure" {
  name      = "Infrastructure"
  parent_id = local.root_id
}

resource "aws_organizations_organizational_unit" "workloads" {
  name      = "Workloads"
  parent_id = local.root_id
}

resource "aws_organizations_organizational_unit" "nonprod" {
  name      = "NonProd"
  parent_id = aws_organizations_organizational_unit.workloads.id
}

resource "aws_organizations_organizational_unit" "prod" {
  name      = "Prod"
  parent_id = aws_organizations_organizational_unit.workloads.id
}

resource "aws_organizations_account" "member" {
  for_each = local.account_ous

  name              = each.key
  email             = var.account_emails[each.key]
  parent_id         = local.ou_ids[each.value]
  close_on_deletion = false

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [role_name, iam_user_access_to_billing]
  }
}

# Human access through IAM Identity Center only (REQ-INFRA-003, DT-INFRA-002).
# No IAM users are created anywhere. The identity source is the Identity
# Center directory (spec decision 2026-09-26).
#
# DT-INFRA-002 #4 (Dev -> prod ViewOnly for 4 hours on Ops approval) is NOT a
# standing assignment: it is created and deleted by the documented procedure in
# infra/README.md, and both actions are recorded by CloudTrail.

data "aws_ssoadmin_instances" "this" {}

locals {
  instance_arn      = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  identity_store_id = tolist(data.aws_ssoadmin_instances.this.identity_store_ids)[0]

  all_accounts = ["management", "security", "log-archive", "shared", "dev", "staging", "prod"]

  # DT-INFRA-002, standing assignments: group -> account -> permission sets.
  access = {
    # #1: Ops -> every account
    Ops = { for a in local.all_accounts : a => ["ViewOnly", "BreakGlass"] }
    Dev = {
      # #2: Dev -> dev
      dev = ["ViewOnly", "DevPowerUser"]
      # #3: Dev -> staging, shared
      staging = ["ViewOnly"]
      shared  = ["ViewOnly"]
      # #4: prod has no standing assignment; #5: none for management/security/log-archive
    }
  }

  assignments = merge([
    for group, accounts in local.access : merge([
      for account, sets in accounts : {
        for ps in sets : "${group}/${account}/${ps}" => { group = group, account = account, permission_set = ps }
      }
    ]...)
  ]...)

  groups = {
    Ops = "Operations: read-only daily access everywhere, break-glass on incidents"
    Dev = "Developers"
  }

  permission_set_arns = {
    ViewOnly     = aws_ssoadmin_permission_set.view_only.arn
    BreakGlass   = aws_ssoadmin_permission_set.break_glass.arn
    DevPowerUser = aws_ssoadmin_permission_set.dev_power_user.arn
  }
}

resource "aws_identitystore_group" "this" {
  for_each = local.groups

  identity_store_id = local.identity_store_id
  display_name      = each.key
  description       = each.value
}

# ViewOnly: configuration only; no data (objects, secret values, log contents, DB).
resource "aws_ssoadmin_permission_set" "view_only" {
  name             = "ViewOnly"
  description      = "Read resource configuration; no data access (DT-INFRA-002)"
  instance_arn     = local.instance_arn
  session_duration = "PT8H"
}

resource "aws_ssoadmin_managed_policy_attachment" "view_only" {
  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.view_only.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
}

# BreakGlass: administrator, one-hour sessions, every use is notified (REQ-INFRA-004).
resource "aws_ssoadmin_permission_set" "break_glass" {
  name             = "BreakGlass"
  description      = "Emergency administrator access; notifies Ops on every sign-in (REQ-INFRA-004)"
  instance_arn     = local.instance_arn
  session_duration = "PT1H"
}

resource "aws_ssoadmin_managed_policy_attachment" "break_glass" {
  #checkov:skip=CKV_AWS_274:BreakGlass is the emergency administrator permission set defined by DT-INFRA-002 approved-by:PENDING
  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.break_glass.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# DevPowerUser: PowerUser minus IAM, Organizations and account settings.
resource "aws_ssoadmin_permission_set" "dev_power_user" {
  name             = "DevPowerUser"
  description      = "Developer access to dev, without IAM, Organizations and account settings (DT-INFRA-002 #2)"
  instance_arn     = local.instance_arn
  session_duration = "PT8H"
}

resource "aws_ssoadmin_managed_policy_attachment" "dev_power_user" {
  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.dev_power_user.arn
  managed_policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

resource "aws_ssoadmin_permission_set_inline_policy" "dev_power_user" {
  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.dev_power_user.arn

  inline_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "NoIamOrganizationsOrAccountSettings"
      Effect   = "Deny"
      Action   = ["iam:*", "organizations:*", "account:*"]
      Resource = "*"
    }]
  })
}

resource "aws_ssoadmin_account_assignment" "this" {
  for_each = local.assignments

  instance_arn       = local.instance_arn
  permission_set_arn = local.permission_set_arns[each.value.permission_set]
  principal_type     = "GROUP"
  principal_id       = aws_identitystore_group.this[each.value.group].group_id
  target_type        = "AWS_ACCOUNT"
  target_id          = var.account_ids[each.value.account]
}

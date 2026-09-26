# Root module tests for global/identity-center (REQ-INFRA-003, DT-INFRA-002).
# One run per DT-INFRA-002 row. Plan only, against a mock provider.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_ssoadmin_instances" {
    defaults = {
      arns               = ["arn:aws:sso:::instance/ssoins-0000000000000000"]
      identity_store_ids = ["d-0000000000"]
    }
  }
}

variables {
  account_ids = {
    management    = "111111111111"
    security      = "222222222222"
    "log-archive" = "333333333333"
    shared        = "444444444444"
    dev           = "555555555555"
    staging       = "666666666666"
    prod          = "777777777777"
  }
}

run "dt_infra_002_row1_ops_gets_view_only_and_break_glass_everywhere" {
  command = plan

  assert {
    condition = toset([for k, v in aws_ssoadmin_account_assignment.this : "${v.target_id}/${split("/", k)[2]}" if startswith(k, "Ops/")]) == toset(flatten([
      for id in ["111111111111", "222222222222", "333333333333", "444444444444", "555555555555", "666666666666", "777777777777"] :
      ["${id}/ViewOnly", "${id}/BreakGlass"]
    ]))
    error_message = "DT-INFRA-002 #1: Ops has ViewOnly and BreakGlass in all seven accounts, nothing else."
  }
}

run "dt_infra_002_row2_dev_gets_view_only_and_power_user_in_dev" {
  command = plan

  assert {
    condition     = toset([for k, v in aws_ssoadmin_account_assignment.this : split("/", k)[2] if startswith(k, "Dev/") && v.target_id == "555555555555"]) == toset(["ViewOnly", "DevPowerUser"])
    error_message = "DT-INFRA-002 #2: Dev has ViewOnly and DevPowerUser in dev."
  }

  assert {
    condition     = toset(jsondecode(aws_ssoadmin_permission_set_inline_policy.dev_power_user.inline_policy).Statement[0].Action) == toset(["iam:*", "organizations:*", "account:*"])
    error_message = "DT-INFRA-002 #2: DevPowerUser excludes IAM, Organizations and account settings."
  }
}

run "dt_infra_002_row3_dev_gets_view_only_in_staging_and_shared" {
  command = plan

  assert {
    condition = toset([for k, v in aws_ssoadmin_account_assignment.this : "${v.target_id}/${split("/", k)[2]}" if startswith(k, "Dev/") && contains(["666666666666", "444444444444"], v.target_id)]) == toset([
      "666666666666/ViewOnly", "444444444444/ViewOnly",
    ])
    error_message = "DT-INFRA-002 #3: Dev has only ViewOnly in staging and shared."
  }
}

run "dt_infra_002_row4_dev_has_no_standing_access_to_prod" {
  command = plan

  assert {
    condition     = length([for k, v in aws_ssoadmin_account_assignment.this : k if startswith(k, "Dev/") && v.target_id == "777777777777"]) == 0
    error_message = "DT-INFRA-002 #4 / REQ-INFRA-003: Dev has no standing assignment in prod (so prod is not listed in the portal)."
  }
}

run "dt_infra_002_row5_dev_has_nothing_in_foundation_accounts" {
  command = plan

  assert {
    condition     = length([for k, v in aws_ssoadmin_account_assignment.this : k if startswith(k, "Dev/") && contains(["111111111111", "222222222222", "333333333333"], v.target_id)]) == 0
    error_message = "DT-INFRA-002 #5: Dev has no access to management, security or log-archive."
  }
}

run "dt_infra_002_row6_only_ops_and_dev_groups_exist" {
  command = plan

  assert {
    condition     = toset(keys(aws_identitystore_group.this)) == toset(["Ops", "Dev"]) && length(aws_ssoadmin_account_assignment.this) == 18
    error_message = "DT-INFRA-002 #6: no other group has any assignment (14 Ops + 4 Dev)."
  }
}

run "req_infra_004_break_glass_sessions_last_one_hour" {
  command = plan

  assert {
    condition     = aws_ssoadmin_permission_set.break_glass.session_duration == "PT1H" && aws_ssoadmin_permission_set.break_glass.name == "BreakGlass"
    error_message = "DT-INFRA-002: BreakGlass sessions last one hour."
  }

  assert {
    condition     = aws_ssoadmin_managed_policy_attachment.view_only.managed_policy_arn == "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
    error_message = "REQ-INFRA-003: ViewOnly only reads configuration (AWS ViewOnlyAccess)."
  }
}

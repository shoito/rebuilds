# Structural checks of the role permissions (PROP-INFRA-004, REQ-INFRA-003, REQ-INFRA-013).
# The property itself is verified against AWS with IAM Policy Simulator in infra/test.

# Runs apply against the mock provider (no AWS calls) so computed ARNs are known.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::123456789012:policy/tf-apply-boundary"
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }
}

variables {
  apply_environment  = "dev"
  state_bucket_arns  = ["arn:aws:s3:::slack-tfstate-123456789012-ap-northeast-1"]
  state_kms_key_arns = ["arn:aws:kms:ap-northeast-1:123456789012:key/state"]
}

run "prop_infra_004_plan_role_denies_every_listed_data_read" {
  assert {
    condition = length(setsubtract(
      ["secretsmanager:GetSecretValue", "logs:GetLogEvents", "logs:StartQuery", "rds-data:*", "dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query", "sqs:ReceiveMessage"],
      [for s in jsondecode(aws_iam_role_policy.plan_deny.policy).Statement : s.Action if s.Sid == "DenyDataReads"][0],
    )) == 0
    error_message = "PROP-INFRA-004: every data read listed in the spec must be denied explicitly."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.plan_deny.policy).Statement :
      s.Effect == "Deny" && contains(flatten([s.Action]), "s3:GetObject") && s.NotResource == ["arn:aws:s3:::slack-tfstate-123456789012-ap-northeast-1/*"]
    ])
    error_message = "PROP-INFRA-004: s3:GetObject is denied outside the state bucket."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.plan_deny.policy).Statement :
      s.Effect == "Deny" && contains(flatten([s.Action]), "kms:Decrypt") && s.NotResource == ["arn:aws:kms:ap-northeast-1:123456789012:key/state"]
    ])
    error_message = "PROP-INFRA-004: kms:Decrypt is denied except with the state key."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_role_policy.plan_deny.policy).Statement :
      s.Effect == "Deny" && contains(flatten([s.Action]), "s3:PutObject") && s.NotResource == ["arn:aws:s3:::slack-tfstate-123456789012-ap-northeast-1/*.tflock"]
    ])
    error_message = "PROP-INFRA-004: object writes are denied except the *.tflock lock files."
  }
}

run "prop_infra_004_plan_role_allows_no_write_prefix" {
  assert {
    condition = length([
      for a in flatten([for s in jsondecode(aws_iam_role_policy.plan_read.policy).Statement : s.Action if s.Effect == "Allow"]) :
      a if can(regex(":(Create|Put|Update|Delete|Attach|Modify)", a)) && !contains(["s3:PutObject", "s3:DeleteObject"], a)
    ]) == 0
    error_message = "PROP-INFRA-004: tf-plan must not be allowed any Create*/Put*/Update*/Delete*/Attach*/Modify* action (except the lock file)."
  }

  assert {
    condition = alltrue([
      for s in jsondecode(aws_iam_role_policy.plan_read.policy).Statement :
      s.Resource == ["arn:aws:s3:::slack-tfstate-123456789012-ap-northeast-1/*.tflock"] if s.Sid == "WriteLockFileOnly"
    ])
    error_message = "PROP-INFRA-004: lock file writes are limited to *.tflock in the state bucket."
  }
}

run "req_infra_013_apply_role_is_bounded" {
  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.apply_boundary.policy).Statement :
      s.Effect == "Deny" && contains(flatten([s.Resource]), "arn:aws:iam::123456789012:role/tf-*") && contains(flatten([s.Resource]), "arn:aws:iam::123456789012:role/aws-reserved/sso.amazonaws.com/*")
    ])
    error_message = "Spec Design: the boundary prevents tf-apply from changing tf-* and AWSReservedSSO_* roles."
  }

  assert {
    condition = anytrue([
      for s in jsondecode(aws_iam_policy.apply_boundary.policy).Statement :
      s.Effect == "Deny" && contains(flatten([s.Action]), "iam:CreateUser") && contains(flatten([s.Action]), "iam:CreateAccessKey")
    ])
    error_message = "REQ-INFRA-003 / REQ-INFRA-013: tf-apply cannot create IAM users or long-lived access keys."
  }

  assert {
    condition     = aws_iam_role.apply.name == "tf-apply" && aws_iam_role.plan.name == "tf-plan"
    error_message = "REQ-INFRA-013: role names are tf-plan and tf-apply."
  }
}

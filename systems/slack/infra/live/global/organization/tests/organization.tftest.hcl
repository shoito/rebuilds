# Root module tests for global/organization (REQ-INFRA-001, REQ-INFRA-002, DT-INFRA-001).
# Plan only, against a mock provider. The SCP behaviour itself is checked with
# IAM Policy Simulator and a real dev call in infra/test (plan.md Proof).

mock_provider "aws" {
  override_during = plan

  mock_resource "aws_organizations_organization" {
    defaults = {
      id    = "o-example123"
      roots = [{ id = "r-root", arn = "arn:aws:organizations::111111111111:root/o-example123/r-root", name = "Root", policy_types = [] }]
    }
  }
}

override_resource {
  target          = aws_organizations_organizational_unit.security
  override_during = plan
  values = {
    id = "ou-root-security"
  }
}

override_resource {
  target          = aws_organizations_organizational_unit.infrastructure
  override_during = plan
  values = {
    id = "ou-root-infrastructure"
  }
}

override_resource {
  target          = aws_organizations_organizational_unit.workloads
  override_during = plan
  values = {
    id = "ou-root-workloads"
  }
}

override_resource {
  target          = aws_organizations_organizational_unit.nonprod
  override_during = plan
  values = {
    id = "ou-root-nonprod01"
  }
}

override_resource {
  target          = aws_organizations_organizational_unit.prod
  override_during = plan
  values = {
    id = "ou-root-prod0001"
  }
}

variables {
  account_emails = {
    security      = "aws+security@example.com"
    "log-archive" = "aws+log-archive@example.com"
    shared        = "aws+shared@example.com"
    dev           = "aws+dev@example.com"
    staging       = "aws+staging@example.com"
    prod          = "aws+prod@example.com"
  }
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

run "req_infra_001_accounts_are_in_the_expected_ous" {
  command = plan

  assert {
    condition     = toset(keys(aws_organizations_account.member)) == toset(["security", "log-archive", "shared", "dev", "staging", "prod"])
    error_message = "REQ-INFRA-001: exactly the six member accounts exist (management is the organization account)."
  }

  assert {
    condition = (
      aws_organizations_account.member["security"].parent_id == aws_organizations_organizational_unit.security.id &&
      aws_organizations_account.member["log-archive"].parent_id == aws_organizations_organizational_unit.security.id &&
      aws_organizations_account.member["shared"].parent_id == aws_organizations_organizational_unit.infrastructure.id &&
      aws_organizations_account.member["dev"].parent_id == aws_organizations_organizational_unit.nonprod.id &&
      aws_organizations_account.member["staging"].parent_id == aws_organizations_organizational_unit.nonprod.id &&
      aws_organizations_account.member["prod"].parent_id == aws_organizations_organizational_unit.prod.id
    )
    error_message = "REQ-INFRA-001: security/log-archive -> Security, shared -> Infrastructure, dev/staging -> Workloads/NonProd, prod -> Workloads/Prod."
  }

  assert {
    condition = (
      aws_organizations_organizational_unit.nonprod.parent_id == aws_organizations_organizational_unit.workloads.id &&
      aws_organizations_organizational_unit.prod.parent_id == aws_organizations_organizational_unit.workloads.id &&
      aws_organizations_organizational_unit.nonprod.name == "NonProd" &&
      aws_organizations_organizational_unit.prod.name == "Prod" &&
      alltrue([for ou in [aws_organizations_organizational_unit.security, aws_organizations_organizational_unit.infrastructure, aws_organizations_organizational_unit.workloads] : ou.parent_id == "r-root"])
    )
    error_message = "REQ-INFRA-001: Security, Infrastructure and Workloads sit under Root; NonProd and Prod under Workloads."
  }
}

run "dt_infra_001_row1_audit_services_cannot_be_stopped" {
  command = plan

  assert {
    condition = length(setsubtract([
      "cloudtrail:StopLogging", "cloudtrail:DeleteTrail", "cloudtrail:UpdateTrail",
      "guardduty:DeleteDetector", "guardduty:DisassociateFromAdministratorAccount",
      "config:StopConfigurationRecorder", "config:DeleteConfigurationRecorder", "config:DeleteDeliveryChannel",
    ], flatten([for s in jsondecode(aws_organizations_policy.protect.content).Statement : s.Action if s.Effect == "Deny" && s.Resource == "*"]))) == 0
    error_message = "DT-INFRA-001 #1: every audit stop/delete action is denied."
  }
}

run "dt_infra_001_row2_leaving_the_organization_is_denied" {
  command = plan

  assert {
    condition     = contains(flatten([for s in jsondecode(aws_organizations_policy.protect.content).Statement : flatten([s.Action]) if s.Effect == "Deny"]), "organizations:LeaveOrganization")
    error_message = "DT-INFRA-001 #2: organizations:LeaveOrganization is denied."
  }
}

run "dt_infra_001_row3_root_user_is_denied" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_organizations_policy.protect.content).Statement :
      s.Effect == "Deny" && s.Action == "*" && try(s.Condition.StringLike["aws:PrincipalArn"], "") == "arn:aws:iam::*:root"
    ])
    error_message = "DT-INFRA-001 #3: every action of the account root user is denied."
  }
}

run "dt_infra_001_row4_tokyo_and_osaka_are_left_to_iam" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_organizations_policy.regions.content).Statement :
      s.Effect == "Deny" && can(s.NotAction) && toset(s.Condition.StringNotEquals["aws:RequestedRegion"]) == toset(["ap-northeast-1", "ap-northeast-3"])
    ])
    error_message = "DT-INFRA-001 #4: non-global actions are denied outside ap-northeast-1 and ap-northeast-3 only."
  }
}

run "dt_infra_001_row5_global_services_are_allowed_in_us_east_1" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_organizations_policy.regions.content).Statement :
      s.Effect == "Deny" && can(s.Action) &&
      toset(s.Condition.StringNotEquals["aws:RequestedRegion"]) == toset(["ap-northeast-1", "ap-northeast-3", "us-east-1"]) &&
      length(setsubtract(["iam:*", "organizations:*", "sts:*", "cloudfront:*", "wafv2:*", "acm:*", "route53:*", "sso:*", "identitystore:*", "support:*", "budgets:*", "ce:*"], s.Action)) == 0
    ])
    error_message = "DT-INFRA-001 #5: IAM, Organizations, STS, CloudFront, WAF, ACM, Route 53, Identity Center, Support, Budgets and Cost Explorer are allowed in us-east-1."
  }
}

run "dt_infra_001_row6_other_regions_are_denied_for_every_member_ou" {
  command = plan

  assert {
    condition = (
      toset([for a in aws_organizations_policy_attachment.regions : a.target_id]) == toset([
        aws_organizations_organizational_unit.security.id,
        aws_organizations_organizational_unit.infrastructure.id,
        aws_organizations_organizational_unit.workloads.id,
      ]) &&
      toset([for a in aws_organizations_policy_attachment.protect : a.target_id]) == toset([
        aws_organizations_organizational_unit.security.id,
        aws_organizations_organizational_unit.infrastructure.id,
        aws_organizations_organizational_unit.workloads.id,
      ])
    )
    error_message = "DT-INFRA-001 #6 / REQ-INFRA-002: both SCPs apply to every member account (all top-level OUs)."
  }
}

run "req_infra_005_organization_trail_records_all_accounts_and_regions" {
  command = plan

  assert {
    condition = (
      aws_cloudtrail.organization[0].is_organization_trail &&
      aws_cloudtrail.organization[0].is_multi_region_trail &&
      aws_cloudtrail.organization[0].include_global_service_events &&
      aws_cloudtrail.organization[0].enable_log_file_validation
    )
    error_message = "REQ-INFRA-005: the trail covers every account and region of the organization."
  }

  assert {
    condition = (
      aws_cloudtrail.organization[0].s3_bucket_name == "slack-cloudtrail-333333333333" &&
      aws_cloudtrail.organization[0].kms_key_id == "arn:aws:kms:ap-northeast-1:333333333333:alias/cloudtrail"
    )
    error_message = "REQ-INFRA-005: logs go to the log-archive bucket, encrypted with the log-archive CMK."
  }
}

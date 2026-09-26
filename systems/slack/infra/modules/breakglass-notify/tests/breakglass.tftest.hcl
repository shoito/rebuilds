# Module tests for breakglass-notify (REQ-INFRA-004, REQ-INFRA-018).
# The rule pattern is unit-tested here; delivery within 5 minutes is the manual
# staging acceptance test in plan.md Proof.

mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "222222222222"
    }
  }

  mock_resource "aws_cloudwatch_event_bus" {
    defaults = {
      arn = "arn:aws:events:ap-northeast-1:222222222222:event-bus/breakglass"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-northeast-1:222222222222:breakglass-signin"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:ap-northeast-1:222222222222:key/notify"
    }
  }

  mock_resource "aws_cloudwatch_event_rule" {
    defaults = {
      arn = "arn:aws:events:ap-northeast-1:222222222222:rule/breakglass/breakglass-signin-notify"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::222222222222:role/breakglass-forwarder"
    }
  }
}

run "req_infra_004_rule_matches_only_breakglass_sso_sign_ins" {
  command = plan

  variables {
    hub_event_bus_arn = "arn:aws:events:ap-northeast-1:111111111111:event-bus/breakglass"
  }

  assert {
    condition = (
      jsondecode(aws_cloudwatch_event_rule.forward.event_pattern).detail.eventName == ["AssumeRoleWithSAML"] &&
      jsondecode(aws_cloudwatch_event_rule.forward.event_pattern)["detail-type"] == ["AWS API Call via CloudTrail"]
    )
    error_message = "REQ-INFRA-004: the rule matches SSO sign-ins recorded by CloudTrail."
  }

  assert {
    condition = alltrue([
      for f in jsondecode(aws_cloudwatch_event_rule.forward.event_pattern).detail.requestParameters.roleArn :
      strcontains(f.wildcard, "AWSReservedSSO_BreakGlass_")
    ])
    error_message = "REQ-INFRA-004: only the BreakGlass permission set matches."
  }

  assert {
    condition     = !strcontains(aws_cloudwatch_event_rule.forward.event_pattern, "ViewOnly")
    error_message = "REQ-INFRA-004: sign-ins with ViewOnly must not notify."
  }
}

run "req_infra_004_member_accounts_forward_to_the_security_hub_bus" {
  command = plan

  variables {
    hub_event_bus_arn = "arn:aws:events:ap-northeast-1:111111111111:event-bus/breakglass"
  }

  assert {
    condition     = aws_cloudwatch_event_target.forward.arn == "arn:aws:events:ap-northeast-1:111111111111:event-bus/breakglass"
    error_message = "REQ-INFRA-004: member accounts forward to the security account's bus."
  }

  assert {
    condition     = length(aws_sns_topic.notify) == 0 && length(aws_cloudwatch_event_bus.hub) == 0
    error_message = "REQ-INFRA-004: only the security account hosts the topic and hub bus."
  }
}

run "req_infra_004_hub_notifies_user_account_and_time_to_sns" {
  command = plan

  variables {
    create_hub      = true
    organization_id = "o-example123"
  }

  assert {
    condition     = aws_cloudwatch_event_target.notify[0].arn == aws_sns_topic.notify[0].arn
    error_message = "REQ-INFRA-004: the hub rule publishes to the Ops SNS topic."
  }

  assert {
    condition = (
      aws_cloudwatch_event_target.notify[0].input_transformer[0].input_paths["user"] == "$.detail.userIdentity.userName" &&
      aws_cloudwatch_event_target.notify[0].input_transformer[0].input_paths["account"] == "$.detail.recipientAccountId" &&
      aws_cloudwatch_event_target.notify[0].input_transformer[0].input_paths["time"] == "$.detail.eventTime"
    )
    error_message = "REQ-INFRA-004: the notification contains the user, the account ID and the time."
  }

  assert {
    condition     = aws_sns_topic.notify[0].kms_master_key_id == aws_kms_key.notify[0].arn
    error_message = "ADR-0017: the topic is encrypted with a customer managed key."
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_bus_policy.hub[0].policy).Statement[0].Condition.StringEquals["aws:PrincipalOrgID"] == "o-example123"
    error_message = "REQ-INFRA-004: only accounts of the organization can put events on the hub bus."
  }

  assert {
    condition     = aws_cloudwatch_event_target.forward.arn == aws_cloudwatch_event_bus.hub[0].arn
    error_message = "REQ-INFRA-004: sign-ins to the security account itself are forwarded to the hub too."
  }
}

run "req_infra_004_requires_a_hub_target" {
  command = plan

  expect_failures = [var.hub_event_bus_arn]
}

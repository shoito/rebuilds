# Break-glass sign-in notification (REQ-INFRA-004): EventBridge -> SNS.
#
# Every account forwards the CloudTrail event of a sign-in with the BreakGlass
# permission set (sts:AssumeRoleWithSAML into AWSReservedSSO_BreakGlass_*) to
# the central bus in the security account, where a rule publishes user,
# account and time to the Ops SNS topic. Sign-ins with other permission sets
# (e.g. ViewOnly) do not match.
#
# Unverified: the region in which the AssumeRoleWithSAML event is emitted for
# Identity Center sign-ins; the rule lives in the provider's region
# (ap-northeast-1). Confirm with the staging acceptance test (plan.md Proof).

data "aws_caller_identity" "current" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  hub_bus_arn = var.create_hub ? aws_cloudwatch_event_bus.hub[0].arn : var.hub_event_bus_arn

  breakglass_pattern = {
    source        = ["aws.sts"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["sts.amazonaws.com"]
      eventName   = ["AssumeRoleWithSAML"]
      requestParameters = {
        roleArn = [{ wildcard = "arn:aws:iam::*:role/aws-reserved/sso.amazonaws.com/*AWSReservedSSO_BreakGlass_*" }]
      }
    }
  }
}

# --- Source: forward break-glass sign-ins of this account to the hub bus.

resource "aws_cloudwatch_event_rule" "forward" {
  name          = "breakglass-signin-forward"
  description   = "Forward BreakGlass sign-ins to the security account (REQ-INFRA-004)"
  event_pattern = jsonencode(local.breakglass_pattern)
}

resource "aws_iam_role" "forward" {
  name                 = "breakglass-forwarder"
  description          = "EventBridge role that puts break-glass events on the security hub bus"
  permissions_boundary = var.permissions_boundary_arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
    }]
  })
}

resource "aws_iam_role_policy" "forward" {
  name = "put-events-to-hub"
  role = aws_iam_role.forward.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "events:PutEvents"
      Resource = local.hub_bus_arn
    }]
  })
}

resource "aws_cloudwatch_event_target" "forward" {
  rule     = aws_cloudwatch_event_rule.forward.name
  arn      = local.hub_bus_arn
  role_arn = aws_iam_role.forward.arn
}

# --- Hub (security account only): bus, KMS-encrypted SNS topic, notification rule.

resource "aws_cloudwatch_event_bus" "hub" {
  count = var.create_hub ? 1 : 0

  name = "breakglass"
}

resource "aws_cloudwatch_event_bus_policy" "hub" {
  count = var.create_hub ? 1 : 0

  event_bus_name = aws_cloudwatch_event_bus.hub[0].name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OrganizationAccountsPutEvents"
      Effect    = "Allow"
      Principal = "*"
      Action    = "events:PutEvents"
      Resource  = aws_cloudwatch_event_bus.hub[0].arn
      Condition = { StringEquals = { "aws:PrincipalOrgID" = var.organization_id } }
    }]
  })

  lifecycle {
    precondition {
      condition     = var.organization_id != null
      error_message = "organization_id is required when create_hub = true."
    }
  }
}

resource "aws_kms_key" "notify" {
  count = var.create_hub ? 1 : 0

  description             = "Break-glass notification topic"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "EventBridgePublishesEncrypted"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = ["kms:GenerateDataKey*", "kms:Decrypt"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account_id } }
      },
    ]
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_sns_topic" "notify" {
  count = var.create_hub ? 1 : 0

  name              = "breakglass-signin"
  kms_master_key_id = aws_kms_key.notify[0].arn
}

resource "aws_sns_topic_policy" "notify" {
  count = var.create_hub ? 1 : 0

  arn = aws_sns_topic.notify[0].arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "EventBridgePublish"
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sns:Publish"
      Resource  = aws_sns_topic.notify[0].arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.notify[0].arn } }
    }]
  })
}

resource "aws_cloudwatch_event_rule" "notify" {
  count = var.create_hub ? 1 : 0

  name           = "breakglass-signin-notify"
  description    = "Notify Ops of BreakGlass sign-ins in any account (REQ-INFRA-004)"
  event_bus_name = aws_cloudwatch_event_bus.hub[0].name
  event_pattern  = jsonencode(local.breakglass_pattern)
}

resource "aws_cloudwatch_event_target" "notify" {
  count = var.create_hub ? 1 : 0

  rule           = aws_cloudwatch_event_rule.notify[0].name
  event_bus_name = aws_cloudwatch_event_bus.hub[0].name
  arn            = aws_sns_topic.notify[0].arn

  input_transformer {
    input_paths = {
      user    = "$.detail.userIdentity.userName"
      account = "$.detail.recipientAccountId"
      time    = "$.detail.eventTime"
      role    = "$.detail.requestParameters.roleArn"
    }
    input_template = "\"BREAK-GLASS sign-in: user=<user> account=<account> time=<time> role=<role>\""
  }
}

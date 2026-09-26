# Guardrail SCPs implementing DT-INFRA-001 (REQ-INFRA-002). SCPs do not apply
# to the management account. Rows are evaluated as follows:
#   #1-#3: explicit denies (audit services, leaving the organization, root user)
#   #4:    anything in ap-northeast-1 / ap-northeast-3 is left to IAM
#   #5:    global services are also left to IAM in us-east-1
#   #6:    everything else is denied

locals {
  allowed_regions = ["ap-northeast-1", "ap-northeast-3"]

  # DT-INFRA-001 #5: global services usable in us-east-1.
  global_service_actions = [
    "iam:*",
    "organizations:*",
    "sts:*",
    "cloudfront:*",
    "waf:*",
    "wafv2:*",
    "acm:*",
    "route53:*",
    "route53domains:*",
    "sso:*",
    "sso-directory:*",
    "identitystore:*",
    "support:*",
    "budgets:*",
    "ce:*",
  ]

  scp_protect = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DtInfra001Row1DenyAuditTampering"
        Effect = "Deny"
        Action = [
          "cloudtrail:StopLogging",
          "cloudtrail:DeleteTrail",
          "cloudtrail:UpdateTrail",
          "guardduty:DeleteDetector",
          "guardduty:DisassociateFromAdministratorAccount",
          "config:StopConfigurationRecorder",
          "config:DeleteConfigurationRecorder",
          "config:DeleteDeliveryChannel",
        ]
        Resource = "*"
      },
      {
        Sid      = "DtInfra001Row2DenyLeaveOrganization"
        Effect   = "Deny"
        Action   = "organizations:LeaveOrganization"
        Resource = "*"
      },
      {
        Sid       = "DtInfra001Row3DenyRootUser"
        Effect    = "Deny"
        Action    = "*"
        Resource  = "*"
        Condition = { StringLike = { "aws:PrincipalArn" = "arn:aws:iam::*:root" } }
      },
    ]
  }

  scp_regions = {
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DtInfra001Row4To6DenyOtherRegions"
        Effect    = "Deny"
        NotAction = local.global_service_actions
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:RequestedRegion" = local.allowed_regions } }
      },
      {
        Sid       = "DtInfra001Row5To6GlobalServicesOnlyInUsEast1"
        Effect    = "Deny"
        Action    = local.global_service_actions
        Resource  = "*"
        Condition = { StringNotEquals = { "aws:RequestedRegion" = concat(local.allowed_regions, ["us-east-1"]) } }
      },
    ]
  }
}

resource "aws_organizations_policy" "protect" {
  name        = "slack-guardrails-protect"
  description = "DT-INFRA-001 #1-#3: audit services, leaving the organization, root user"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode(local.scp_protect)
}

resource "aws_organizations_policy" "regions" {
  name        = "slack-guardrails-regions"
  description = "DT-INFRA-001 #4-#6: Tokyo and Osaka only; global services also in us-east-1"
  type        = "SERVICE_CONTROL_POLICY"
  content     = jsonencode(local.scp_regions)
}

resource "aws_organizations_policy_attachment" "protect" {
  for_each = var.scp_target_ous

  policy_id = aws_organizations_policy.protect.id
  target_id = local.ou_ids[each.key]
}

resource "aws_organizations_policy_attachment" "regions" {
  for_each = var.scp_target_ous

  policy_id = aws_organizations_policy.regions.id
  target_id = local.ou_ids[each.key]
}

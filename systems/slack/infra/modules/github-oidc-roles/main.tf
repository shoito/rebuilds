# GitHub Actions OIDC provider and the tf-plan / tf-apply roles of one account
# (REQ-INFRA-013, DT-INFRA-005, PROP-INFRA-004). No long-lived access keys.
#
# The repository's OIDC subject template is customised to
# include_claim_keys = ["repo", "context", "ref"], so `sub` looks like
#   repo:<owner>/<repo>:pull_request:ref:refs/pull/<n>/merge
#   repo:<owner>/<repo>:ref:refs/heads/main:ref:refs/heads/main
#   repo:<owner>/<repo>:environment:<env>:ref:refs/heads/main
# The exact format is unverified until checked with a real token (plan step 5);
# the patterns below are the single place to adjust.

data "aws_caller_identity" "current" {}

locals {
  issuer    = "token.actions.githubusercontent.com"
  repo_sub  = "repo:${var.repository}"
  audience  = "sts.amazonaws.com"
  state_obj = [for b in var.state_bucket_arns : "${b}/*"]
  lock_obj  = [for b in var.state_bucket_arns : "${b}/*.tflock"]

  # DT-INFRA-005 #2 (same-repository PR without environment) and #3 (main, branch or environment context).
  plan_subjects = [
    "${local.repo_sub}:pull_request:ref:refs/pull/*/merge",
    "${local.repo_sub}:ref:refs/heads/main:ref:refs/heads/main",
    "${local.repo_sub}:environment:*:ref:refs/heads/main",
  ]

  # DT-INFRA-005 #6-9: exactly one environment, on main.
  apply_subject = "${local.repo_sub}:environment:${var.apply_environment}:ref:refs/heads/main"

  # Services whose configuration Terraform refreshes. Data reads are denied explicitly below.
  plan_read_services = [
    "acm", "application-autoscaling", "appconfig", "autoscaling", "backup", "cloudfront", "cloudtrail",
    "cloudwatch", "ec2", "ecr", "ecs", "elasticache", "elasticloadbalancing", "events", "iam",
    "identitystore", "kms", "logs", "organizations", "rds", "route53", "s3", "secretsmanager",
    "servicediscovery", "sns", "sqs", "sso", "ssm", "sts", "wafv2", "xray",
  ]
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.issuer}"
  client_id_list = [local.audience]
}

# --- tf-plan -------------------------------------------------------------------

resource "aws_iam_role" "plan" {
  name                 = "tf-plan"
  description          = "Terraform plan from GitHub Actions (read-only, DT-INFRA-005 #2-4)"
  max_session_duration = 3600

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = { "${local.issuer}:aud" = local.audience }
        StringLike   = { "${local.issuer}:sub" = local.plan_subjects }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "plan_view_only" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"
}

resource "aws_iam_role_policy" "plan_read" {
  name = "terraform-refresh-and-state"
  role = aws_iam_role.plan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadConfigurationForRefresh"
        Effect   = "Allow"
        Action   = flatten([for s in local.plan_read_services : ["${s}:Describe*", "${s}:Get*", "${s}:List*"]])
        Resource = "*"
      },
      {
        Sid      = "ReadState"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = concat(var.state_bucket_arns, local.state_obj)
      },
      {
        Sid      = "WriteLockFileOnly"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = local.lock_obj
      },
      {
        Sid      = "UseStateKey"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = var.state_kms_key_arns
      },
    ]
  })
}

# PROP-INFRA-004: explicit denies win over the allows above and over ViewOnlyAccess.
resource "aws_iam_role_policy" "plan_deny" {
  name = "deny-data-and-writes"
  role = aws_iam_role.plan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "DenyDataReads"
        Effect = "Deny"
        Action = [
          "secretsmanager:GetSecretValue", "secretsmanager:BatchGetSecretValue",
          "logs:GetLogEvents", "logs:FilterLogEvents", "logs:StartQuery", "logs:GetQueryResults", "logs:StartLiveTail", "logs:GetLogRecord",
          "rds-data:*",
          "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Scan", "dynamodb:Query", "dynamodb:GetRecords",
          "sqs:ReceiveMessage",
          "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage",
          "ssm:GetParameterHistory",
        ]
        Resource = "*"
      },
      {
        Sid         = "DenyObjectReadsOutsideState"
        Effect      = "Deny"
        Action      = ["s3:GetObject", "s3:GetObjectVersion"]
        NotResource = local.state_obj
      },
      {
        Sid         = "DenyDecryptOutsideStateKey"
        Effect      = "Deny"
        Action      = ["kms:Decrypt", "kms:GenerateDataKey"]
        NotResource = var.state_kms_key_arns
      },
      {
        Sid         = "DenyObjectWritesOutsideLockFiles"
        Effect      = "Deny"
        Action      = ["s3:PutObject", "s3:DeleteObject"]
        NotResource = local.lock_obj
      },
    ]
  })
}

# --- tf-apply ------------------------------------------------------------------

# Permissions boundary: tf-apply cannot change the CI roles, the SSO roles or
# this boundary, cannot create IAM users, and can only create roles that carry
# this boundary (no escalation through a new role).
resource "aws_iam_policy" "apply_boundary" {
  #checkov:skip=CKV_AWS_288:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV_AWS_290:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV_AWS_287:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV_AWS_63:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV_AWS_289:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV_AWS_62:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV_AWS_355:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV_AWS_286:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  #checkov:skip=CKV2_AWS_40:tf-apply boundary allows everything except the listed denies by design (spec Design OIDC) approved-by:PENDING
  name        = "tf-apply-boundary"
  description = "Permissions boundary for tf-apply and every role it creates"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "AllowByDefault"
        Effect   = "Allow"
        Action   = "*"
        Resource = "*"
      },
      {
        Sid    = "ProtectCiAndSsoRoles"
        Effect = "Deny"
        Action = [
          "iam:AttachRolePolicy", "iam:DeleteRole", "iam:DeleteRolePermissionsBoundary", "iam:DeleteRolePolicy",
          "iam:DetachRolePolicy", "iam:PutRolePermissionsBoundary", "iam:PutRolePolicy", "iam:UpdateAssumeRolePolicy",
          "iam:UpdateRole", "iam:UpdateRoleDescription", "iam:TagRole", "iam:UntagRole",
        ]
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/tf-*",
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/aws-reserved/sso.amazonaws.com/*",
        ]
      },
      {
        Sid    = "ProtectBoundaryAndOidcProvider"
        Effect = "Deny"
        Action = [
          "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
          "iam:DeleteOpenIDConnectProvider", "iam:UpdateOpenIDConnectProviderThumbprint",
          "iam:AddClientIDToOpenIDConnectProvider", "iam:RemoveClientIDFromOpenIDConnectProvider",
        ]
        Resource = [
          "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/tf-apply-boundary",
          aws_iam_openid_connect_provider.github.arn,
        ]
      },
      {
        Sid      = "NoIamUsers"
        Effect   = "Deny"
        Action   = ["iam:CreateUser", "iam:CreateAccessKey", "iam:CreateLoginProfile"]
        Resource = "*"
      },
      {
        Sid       = "NewRolesCarryThisBoundary"
        Effect    = "Deny"
        Action    = ["iam:CreateRole", "iam:PutRolePermissionsBoundary"]
        Resource  = "*"
        Condition = { StringNotEquals = { "iam:PermissionsBoundary" = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/tf-apply-boundary" } }
      },
    ]
  })
}

resource "aws_iam_role" "apply" {
  name                 = "tf-apply"
  description          = "Terraform apply from GitHub Actions on main in environment ${var.apply_environment} (DT-INFRA-005 #5-10)"
  max_session_duration = 3600
  permissions_boundary = aws_iam_policy.apply_boundary.arn

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${local.issuer}:aud" = local.audience
          "${local.issuer}:sub" = local.apply_subject
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "apply_admin" {
  #checkov:skip=CKV_AWS_274:tf-apply needs admin to apply every root module; limited by tf-apply-boundary and main-only trust approved-by:PENDING
  role       = aws_iam_role.apply.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

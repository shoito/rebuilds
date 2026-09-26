# GitHub Actions OIDC roles (REQ-INFRA-013, DT-INFRA-005) and the break-glass
# sign-in notification (REQ-INFRA-004) of this account. Applied by a person
# during bootstrap: tf-apply cannot modify tf-* roles (permissions boundary).

data "aws_ssm_parameter" "state_bucket_arn" {
  name = "/slack/tfstate/bucket-arn"
}

data "aws_ssm_parameter" "state_kms_key_arn" {
  name = "/slack/tfstate/kms-key-arn"
}

module "github_oidc" {
  source = "../../../../modules/github-oidc-roles"

  apply_environment  = "platform"
  state_bucket_arns  = [data.aws_ssm_parameter.state_bucket_arn.value]
  state_kms_key_arns = [data.aws_ssm_parameter.state_kms_key_arn.value]
}

module "breakglass" {
  source = "../../../../modules/breakglass-notify"

  hub_event_bus_arn        = "arn:aws:events:ap-northeast-1:${var.account_ids["security"]}:event-bus/breakglass"
  permissions_boundary_arn = module.github_oidc.apply_boundary_arn
}

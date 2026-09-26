# State bucket of this account/region (REQ-INFRA-006). The first apply uses a
# local backend (backend_override.tf) and is then migrated into the bucket it
# creates with `terraform init -migrate-state` (infra/README.md).
module "state" {
  source = "../../../../modules/state-bucket"
}

# Values for other root modules go through SSM Parameter Store (ADR-0020).
resource "aws_ssm_parameter" "state_bucket_arn" {
  name  = "/slack/tfstate/bucket-arn"
  type  = "String"
  value = module.state.bucket_arn
}

resource "aws_ssm_parameter" "state_kms_key_arn" {
  name  = "/slack/tfstate/kms-key-arn"
  type  = "String"
  value = module.state.kms_key_arn
}

# Osaka state bucket of this account (spec decision 2026-09-26: staging also
# gets one to rehearse disaster recovery). Managed from the Tokyo root because
# DT-INFRA-003 has no staging/ap-northeast-3 row.
module "state_osaka" {
  source = "../../../../modules/state-bucket"

  providers = {
    aws = aws.osaka
  }
}

resource "aws_ssm_parameter" "state_osaka_bucket_arn" {
  provider = aws.osaka

  name  = "/slack/tfstate/bucket-arn"
  type  = "String"
  value = module.state_osaka.bucket_arn
}

resource "aws_ssm_parameter" "state_osaka_kms_key_arn" {
  provider = aws.osaka

  name  = "/slack/tfstate/kms-key-arn"
  type  = "String"
  value = module.state_osaka.kms_key_arn
}

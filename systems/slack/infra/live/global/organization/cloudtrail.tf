# Organization trail (REQ-INFRA-005): management events of every account and
# region, delivered to the Object Lock bucket in log-archive and encrypted with
# the log-archive CMK (alias ARN, since the key lives in another account).

resource "aws_cloudtrail" "organization" {
  #checkov:skip=CKV_AWS_252:no SNS notification per delivered log file is needed approved-by:PENDING
  #checkov:skip=CKV2_AWS_10:CloudWatch Logs integration is part of the observability story (ADR-0021) approved-by:PENDING
  count = var.organization_trail_enabled ? 1 : 0

  name                          = "slack-organization"
  s3_bucket_name                = "slack-cloudtrail-${local.log_archive_id}"
  kms_key_id                    = "arn:aws:kms:ap-northeast-1:${local.log_archive_id}:alias/cloudtrail"
  is_organization_trail         = true
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  depends_on = [aws_organizations_organization.this]

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = local.log_archive_id != null
      error_message = "Set account_ids[\"log-archive\"] in accounts.tfvars.json before enabling the organization trail."
    }
  }
}

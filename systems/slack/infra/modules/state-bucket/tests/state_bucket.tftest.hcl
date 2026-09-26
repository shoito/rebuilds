# Module tests for state-bucket (REQ-INFRA-006, REQ-INFRA-008, REQ-INFRA-018).
# Run with: terraform init -backend=false && terraform test

mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_region" {
    defaults = {
      region = "ap-northeast-1"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000000"
    }
  }
}

run "req_infra_006_bucket_name_is_per_account_and_region" {
  command = plan

  assert {
    condition     = aws_s3_bucket.state.bucket == "slack-tfstate-123456789012-ap-northeast-1"
    error_message = "REQ-INFRA-006: bucket name must be slack-tfstate-<account_id>-<region>."
  }
}

run "req_infra_006_versioning_enabled" {
  command = plan

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "REQ-INFRA-006: versioning must be enabled."
  }
}

run "req_infra_006_sse_kms_with_dedicated_state_key" {
  command = plan

  assert {
    condition = alltrue([
      for r in aws_s3_bucket_server_side_encryption_configuration.state.rule :
      alltrue([
        for d in r.apply_server_side_encryption_by_default :
        d.sse_algorithm == "aws:kms" && d.kms_master_key_id == aws_kms_key.state.arn
      ])
    ])
    error_message = "REQ-INFRA-006: default encryption must be aws:kms with the state CMK."
  }

  assert {
    condition     = aws_kms_key.state.enable_key_rotation && aws_kms_key.state.deletion_window_in_days == 30
    error_message = "ADR-0017: the state CMK must rotate and use the 30-day deletion window."
  }

  assert {
    condition     = aws_kms_key.state.multi_region == false
    error_message = "REQ-INFRA-006: the state key is single-region (Osaka gets its own key)."
  }
}

run "req_infra_006_public_access_block_all_true" {
  command = plan

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.state.block_public_acls,
      aws_s3_bucket_public_access_block.state.block_public_policy,
      aws_s3_bucket_public_access_block.state.ignore_public_acls,
      aws_s3_bucket_public_access_block.state.restrict_public_buckets,
    ])
    error_message = "REQ-INFRA-006: all four public access block settings must be true."
  }
}

run "req_infra_006_policy_denies_insecure_transport" {
  command = plan

  assert {
    condition = anytrue([
      for s in jsondecode(aws_s3_bucket_policy.state.policy).Statement :
      s.Effect == "Deny" && s.Action == "s3:*" && try(s.Condition.Bool["aws:SecureTransport"], "") == "false"
    ])
    error_message = "REQ-INFRA-006: bucket policy must deny requests where aws:SecureTransport is false."
  }
}

run "req_infra_006_noncurrent_versions_kept_for_restore" {
  command = plan

  assert {
    condition     = aws_s3_bucket_lifecycle_configuration.state.rule[0].noncurrent_version_expiration[0].noncurrent_days >= 30
    error_message = "REQ-INFRA-006: previous state versions must be retained so a corrupted state can be restored."
  }
}

run "req_infra_006_rejects_too_short_retention" {
  command = plan

  variables {
    noncurrent_version_retention_days = 7
  }

  expect_failures = [var.noncurrent_version_retention_days]
}

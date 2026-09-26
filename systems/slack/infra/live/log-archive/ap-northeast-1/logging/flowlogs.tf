# VPC flow log buckets (REQ-INFRA-012), one per region that has VPCs:
# slack-flowlogs-<log-archive id>-<region>. Any account of the organization can
# deliver through delivery.logs.amazonaws.com.

locals {
  flowlog_buckets = {
    tokyo = "slack-flowlogs-${local.account_id}-ap-northeast-1"
    osaka = "slack-flowlogs-${local.account_id}-ap-northeast-3"
  }

  flowlog_key_policy = jsonencode({
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
        Sid       = "FlowLogsDelivery"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:SourceOrgID" = local.organization_id } }
      },
    ]
  })
}

data "aws_iam_policy_document" "flowlogs" {
  for_each = local.flowlog_buckets

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = ["arn:aws:s3:::${each.value}", "arn:aws:s3:::${each.value}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "FlowLogsAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl", "s3:ListBucket"]
    resources = ["arn:aws:s3:::${each.value}"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceOrgID"
      values   = [local.organization_id]
    }
  }

  statement {
    sid       = "FlowLogsWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${each.value}/vpc/AWSLogs/*"]

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceOrgID"
      values   = [local.organization_id]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

# --- Tokyo ---------------------------------------------------------------------

resource "aws_kms_key" "flowlogs_tokyo" {
  description             = "VPC flow logs (ap-northeast-1)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = local.flowlog_key_policy

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "flowlogs_tokyo" {
  bucket = local.flowlog_buckets.tokyo

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "flowlogs_tokyo" {
  bucket = aws_s3_bucket.flowlogs_tokyo.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "flowlogs_tokyo" {
  bucket = aws_s3_bucket.flowlogs_tokyo.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "flowlogs_tokyo" {
  bucket = aws_s3_bucket.flowlogs_tokyo.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.flowlogs_tokyo.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "flowlogs_tokyo" {
  bucket = aws_s3_bucket.flowlogs_tokyo.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "flowlogs_tokyo" {
  bucket = aws_s3_bucket.flowlogs_tokyo.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "flowlogs_tokyo" {
  bucket = aws_s3_bucket.flowlogs_tokyo.id
  policy = data.aws_iam_policy_document.flowlogs["tokyo"].json

  depends_on = [aws_s3_bucket_public_access_block.flowlogs_tokyo]
}

# --- Osaka ---------------------------------------------------------------------

resource "aws_kms_key" "flowlogs_osaka" {
  provider = aws.osaka

  description             = "VPC flow logs (ap-northeast-3)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = local.flowlog_key_policy

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket" "flowlogs_osaka" {
  provider = aws.osaka

  bucket = local.flowlog_buckets.osaka

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "flowlogs_osaka" {
  provider = aws.osaka

  bucket = aws_s3_bucket.flowlogs_osaka.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "flowlogs_osaka" {
  provider = aws.osaka

  bucket = aws_s3_bucket.flowlogs_osaka.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "flowlogs_osaka" {
  provider = aws.osaka

  bucket = aws_s3_bucket.flowlogs_osaka.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.flowlogs_osaka.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "flowlogs_osaka" {
  provider = aws.osaka

  bucket = aws_s3_bucket.flowlogs_osaka.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "flowlogs_osaka" {
  provider = aws.osaka

  bucket = aws_s3_bucket.flowlogs_osaka.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "flowlogs_osaka" {
  provider = aws.osaka

  bucket = aws_s3_bucket.flowlogs_osaka.id
  policy = data.aws_iam_policy_document.flowlogs["osaka"].json

  depends_on = [aws_s3_bucket_public_access_block.flowlogs_osaka]
}

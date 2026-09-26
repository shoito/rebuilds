# REQ-INFRA-016 fixture: a bucket added without lifecycle { prevent_destroy = true }.
resource "aws_s3_bucket" "logs" {
  bucket = "slack-example-logs"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "arn:aws:kms:ap-northeast-1:123456789012:key/example"
    }
  }
}

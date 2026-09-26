# REQ-INFRA-016 fixture: a Checkov suppression without a reason or approvers.
resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_144
  bucket = "slack-example-logs"

  lifecycle {
    prevent_destroy = true
  }
}

output "bucket_name" {
  description = "Name of the state bucket (slack-tfstate-<account_id>-<region>)."
  value       = aws_s3_bucket.state.bucket
}

output "bucket_arn" {
  description = "ARN of the state bucket."
  value       = aws_s3_bucket.state.arn
}

output "kms_key_arn" {
  description = "ARN of the state CMK."
  value       = aws_kms_key.state.arn
}

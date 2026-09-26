output "cloudtrail_bucket" {
  description = "Bucket of the organization CloudTrail."
  value       = aws_s3_bucket.cloudtrail.bucket
}

output "flowlog_buckets" {
  description = "Flow log buckets by region."
  value = {
    "ap-northeast-1" = aws_s3_bucket.flowlogs_tokyo.bucket
    "ap-northeast-3" = aws_s3_bucket.flowlogs_osaka.bucket
  }
}

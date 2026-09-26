output "plan_role_arn" {
  description = "ARN of tf-plan."
  value       = aws_iam_role.plan.arn
}

output "apply_role_arn" {
  description = "ARN of tf-apply."
  value       = aws_iam_role.apply.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC provider."
  value       = aws_iam_openid_connect_provider.github.arn
}

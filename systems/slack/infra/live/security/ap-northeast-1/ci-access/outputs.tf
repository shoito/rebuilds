output "plan_role_arn" {
  description = "ARN of tf-plan in this account."
  value       = module.github_oidc.plan_role_arn
}

output "apply_role_arn" {
  description = "ARN of tf-apply in this account."
  value       = module.github_oidc.apply_role_arn
}

output "breakglass_topic_arn" {
  description = "SNS topic that Ops subscribes to for break-glass notifications."
  value       = module.breakglass.topic_arn
}

output "state_bucket" {
  description = "State bucket of this account and region."
  value       = module.state.bucket_name
}

output "state_bucket_osaka" {
  description = "Osaka state bucket of this account."
  value       = module.state_osaka.bucket_name
}

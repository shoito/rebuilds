output "state_bucket" {
  description = "State bucket of this account and region."
  value       = module.state.bucket_name
}

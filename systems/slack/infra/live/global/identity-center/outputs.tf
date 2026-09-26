output "assignments" {
  description = "Standing assignments as group/account/permission-set keys (DT-INFRA-002)."
  value       = sort(keys(local.assignments))
}

output "permission_set_arns" {
  description = "Permission set ARNs by name."
  value       = local.permission_set_arns
}

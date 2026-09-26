output "organization_id" {
  description = "Organization ID. Copy into infra/accounts.tfvars.json after the bootstrap apply."
  value       = aws_organizations_organization.this.id
}

output "account_ids" {
  description = "Member account IDs by name. Copy into infra/accounts.tfvars.json after the bootstrap apply."
  value       = { for name, a in aws_organizations_account.member : name => a.id }
}

output "account_parent_ous" {
  description = "Parent OU name of each member account (REQ-INFRA-001)."
  value       = local.account_ous
}

variable "account_ids" {
  description = "Account IDs by name. CI passes infra/accounts.tfvars.json with -var-file."
  type        = map(string)

  validation {
    condition     = toset(keys(var.account_ids)) == toset(["management", "security", "log-archive", "shared", "dev", "staging", "prod"])
    error_message = "account_ids must list the seven accounts of infrastructure.md section 1."
  }
}

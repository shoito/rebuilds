variable "account_ids" {
  description = "Account IDs by name (null until created). CI passes infra/accounts.tfvars.json with -var-file."
  type        = map(string)

  validation {
    condition     = toset(keys(var.account_ids)) == toset(["management", "security", "log-archive", "shared", "dev", "staging", "prod"])
    error_message = "account_ids must list the seven accounts of infrastructure.md section 1."
  }
}

variable "account_emails" {
  description = "Root e-mail address of each member account. Supplied by CI as TF_VAR_account_emails (a GitHub variable), not committed."
  type        = map(string)

  validation {
    condition     = toset(keys(var.account_emails)) == toset(["security", "log-archive", "shared", "dev", "staging", "prod"])
    error_message = "account_emails must have exactly: security, log-archive, shared, dev, staging, prod."
  }
}

variable "scp_target_ous" {
  description = "OUs the guardrail SCPs are attached to. Roll out with [\"nonprod\"] first, then all (plan.md Risks)."
  type        = set(string)
  default     = ["security", "infrastructure", "workloads"]

  validation {
    condition     = length(setsubtract(var.scp_target_ous, ["security", "infrastructure", "workloads", "nonprod", "prod"])) == 0
    error_message = "scp_target_ous accepts security, infrastructure, workloads, nonprod and prod."
  }
}

variable "organization_trail_enabled" {
  description = "Create the organization trail. false only for the very first bootstrap apply, before log-archive/logging exists."
  type        = bool
  default     = true
}

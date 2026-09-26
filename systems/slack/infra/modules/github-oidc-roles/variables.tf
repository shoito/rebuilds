variable "repository" {
  description = "GitHub repository (owner/name) whose workflows may assume the roles (DT-INFRA-005 #1)."
  type        = string
  default     = "shoito/rebuilds"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repository))
    error_message = "repository must be owner/name."
  }
}

variable "apply_environment" {
  description = "GitHub environment allowed to assume tf-apply in this account (DT-INFRA-005 #6-9)."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod", "platform"], var.apply_environment)
    error_message = "apply_environment must be dev, staging, prod or platform."
  }
}

variable "state_bucket_arns" {
  description = "ARNs of the state buckets of this account (Tokyo and, where present, Osaka)."
  type        = list(string)

  validation {
    condition     = length(var.state_bucket_arns) > 0 && alltrue([for a in var.state_bucket_arns : startswith(a, "arn:aws:s3:::slack-tfstate-")])
    error_message = "state_bucket_arns must list slack-tfstate-* bucket ARNs."
  }
}

variable "state_kms_key_arns" {
  description = "ARNs of the state CMKs of this account."
  type        = list(string)

  validation {
    condition     = length(var.state_kms_key_arns) > 0
    error_message = "At least one state key is required."
  }
}

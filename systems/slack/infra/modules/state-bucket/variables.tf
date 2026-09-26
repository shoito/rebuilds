variable "noncurrent_version_retention_days" {
  description = "Days to keep noncurrent versions of state files, so a corrupted state can be restored from a previous version (REQ-INFRA-006)."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 30
    error_message = "Keep noncurrent state versions for at least 30 days."
  }
}

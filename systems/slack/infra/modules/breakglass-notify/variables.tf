variable "create_hub" {
  description = "true only in the security account: create the central event bus, the SNS topic for Ops and the notification rule."
  type        = bool
  default     = false
}

variable "hub_event_bus_arn" {
  description = "ARN of the central break-glass event bus in the security account. Required when create_hub = false."
  type        = string
  default     = null

  validation {
    condition     = var.create_hub || var.hub_event_bus_arn != null
    error_message = "Set hub_event_bus_arn unless create_hub = true."
  }

  validation {
    condition     = var.hub_event_bus_arn == null || can(regex("^arn:aws:events:[a-z0-9-]+:[0-9]{12}:event-bus/breakglass$", var.hub_event_bus_arn))
    error_message = "hub_event_bus_arn must be the ARN of the breakglass event bus."
  }
}

variable "organization_id" {
  description = "AWS Organizations ID allowed to put events on the hub bus. Required when create_hub = true."
  type        = string
  default     = null
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary attached to the forwarding role (the tf-apply boundary of this account)."
  type        = string
  default     = null
}

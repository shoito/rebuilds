variable "name" {
  description = "Name prefix of the VPC resources, e.g. slack-prod."
  type        = string
}

variable "cidr_block" {
  description = "IPv4 CIDR of the VPC. Must be a /16; every subnet is a /20 (spec Design, network)."
  type        = string

  validation {
    condition     = can(cidrhost(var.cidr_block, 0)) && endswith(var.cidr_block, "/16")
    error_message = "cidr_block must be a valid /16."
  }
}

variable "availability_zones" {
  description = "Exactly three availability zones (NFR-007)."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) == 3 && length(distinct(var.availability_zones)) == 3
    error_message = "Exactly three distinct availability zones are required."
  }
}

variable "nat_per_az" {
  description = "true: one NAT gateway per AZ and each private subnet uses the NAT in its AZ (DT-INFRA-004 #2). false: a single NAT shared by all private subnets (dev only)."
  type        = bool
  default     = true
}

variable "standby" {
  description = "Standby VPC (Osaka): no NAT gateways and no interface endpoints until failover (DT-INFRA-004 #3)."
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "Interface endpoint service suffixes (REQ-INFRA-011). Ignored when standby = true."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "sqs", "secretsmanager", "kms", "logs", "sts", "xray", "appconfig", "appconfigdata"]
}

variable "flow_log_bucket_arn" {
  description = "ARN of the log-archive S3 bucket (in the same region) that receives the flow logs (REQ-INFRA-012)."
  type        = string

  validation {
    condition     = startswith(var.flow_log_bucket_arn, "arn:aws:s3:::")
    error_message = "flow_log_bucket_arn must be an S3 bucket ARN."
  }
}

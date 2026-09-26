output "vpc_id" {
  description = "ID of the VPC."
  value       = aws_vpc.this.id
}

output "vpc_cidr_block" {
  description = "CIDR of the VPC."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "Public subnet IDs by AZ."
  value       = { for az, s in aws_subnet.public : az => s.id }
}

output "private_subnet_ids" {
  description = "Private subnet IDs by AZ."
  value       = { for az, s in aws_subnet.private : az => s.id }
}

output "isolated_subnet_ids" {
  description = "Isolated subnet IDs by AZ."
  value       = { for az, s in aws_subnet.isolated : az => s.id }
}

output "nat_gateway_ids" {
  description = "NAT gateway IDs by AZ (empty when standby)."
  value       = { for az, n in aws_nat_gateway.this : az => n.id }
}

output "endpoint_security_group_id" {
  description = "Security group of the interface endpoints (null when standby)."
  value       = one(aws_security_group.endpoints[*].id)
}

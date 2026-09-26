output "hub_event_bus_arn" {
  description = "ARN of the central break-glass bus (null unless create_hub)."
  value       = one(aws_cloudwatch_event_bus.hub[*].arn)
}

output "topic_arn" {
  description = "ARN of the Ops notification SNS topic (null unless create_hub). Ops subscribes to it."
  value       = one(aws_sns_topic.notify[*].arn)
}

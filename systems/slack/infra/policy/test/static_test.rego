# Unit tests for policy/static (REQ-INFRA-008, REQ-INFRA-016, ADR-0017).
package infra.static_test

import rego.v1

import data.infra.static

file(path, contents) := {"path": path, "contents": contents}

bucket_with_sse(prevent) := {"resource": {
	"aws_s3_bucket": {"state": [{"bucket": "x", "lifecycle": [{"prevent_destroy": prevent}]}]},
	"aws_s3_bucket_server_side_encryption_configuration": {"state": [{
		"bucket": "${aws_s3_bucket.state.id}",
		"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "aws:kms", "kms_master_key_id": "${aws_kms_key.state.arn}"}]}],
	}]},
}}

test_req_infra_016_compliant_bucket_passes if {
	count(static.deny) == 0 with input as [file("m/main.tf", bucket_with_sse(true))]
}

test_req_infra_016_missing_prevent_destroy_fails_with_address if {
	msgs := static.deny with input as [file("m/main.tf", bucket_with_sse(false))]
	some msg in msgs
	contains(msg, "aws_s3_bucket.state")
	contains(msg, "prevent_destroy")
}

test_req_infra_016_missing_lifecycle_block_fails if {
	contents := {"resource": {"aws_kms_key": {"k": [{"enable_key_rotation": true}]}}}
	msgs := static.deny with input as [file("m/main.tf", contents)]
	some msg in msgs
	contains(msg, "aws_kms_key.k")
}

test_req_infra_016_non_stateful_resource_does_not_need_prevent_destroy if {
	contents := {"resource": {"aws_route": {"r": [{"route_table_id": "x"}]}}}
	count(static.deny) == 0 with input as [file("m/main.tf", contents)]
}

test_req_infra_008_dynamodb_table_in_backend_fails if {
	contents := {"terraform": [{"backend": {"s3": [{"key": "k", "region": "ap-northeast-1", "use_lockfile": true, "dynamodb_table": "locks"}]}}]}
	msgs := static.deny with input as [file("r/backend.tf", contents)]
	some msg in msgs
	contains(msg, "dynamodb_table")
}

test_req_infra_008_backend_without_use_lockfile_fails if {
	contents := {"terraform": [{"backend": {"s3": [{"key": "k", "region": "ap-northeast-1"}]}}]}
	msgs := static.deny with input as [file("r/backend.tf", contents)]
	some msg in msgs
	contains(msg, "use_lockfile")
}

test_req_infra_007_non_s3_backend_fails if {
	contents := {"terraform": [{"backend": {"local": [{}]}}]}
	count(static.deny) == 1 with input as [file("r/backend.tf", contents)]
}

test_adr_0017_sse_s3_fails if {
	contents := {"resource": {"aws_s3_bucket_server_side_encryption_configuration": {"b": [{
		"bucket": "${aws_s3_bucket.b.id}",
		"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "AES256"}]}],
	}]}}}
	msgs := static.deny with input as [file("m/main.tf", contents)]
	some msg in msgs
	contains(msg, "customer managed key")
}

test_adr_0017_aws_managed_kms_alias_fails if {
	contents := {"resource": {"aws_s3_bucket_server_side_encryption_configuration": {"b": [{
		"bucket": "${aws_s3_bucket.b.id}",
		"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "aws:kms", "kms_master_key_id": "alias/aws/s3"}]}],
	}]}}}
	count(static.deny) == 1 with input as [file("m/main.tf", contents)]
}

test_adr_0017_bucket_without_sse_configuration_fails if {
	contents := {"resource": {"aws_s3_bucket": {"b": [{"bucket": "x", "lifecycle": [{"prevent_destroy": true}]}]}}}
	msgs := static.deny with input as [file("m/main.tf", contents)]
	some msg in msgs
	contains(msg, "aws_s3_bucket.b")
}

test_adr_0017_sse_configuration_in_sibling_file_counts if {
	bucket := {"resource": {"aws_s3_bucket": {"b": [{"bucket": "x", "lifecycle": [{"prevent_destroy": true}]}]}}}
	sse := {"resource": {"aws_s3_bucket_server_side_encryption_configuration": {"b": [{
		"bucket": "${aws_s3_bucket.b.id}",
		"rule": [{"apply_server_side_encryption_by_default": [{"sse_algorithm": "aws:kms", "kms_master_key_id": "${aws_kms_key.k.arn}"}]}],
	}]}}}
	count(static.deny) == 0 with input as [file("m/main.tf", bucket), file("m/encryption.tf", sse)]
}

test_adr_0017_log_group_without_cmk_fails if {
	contents := {"resource": {"aws_cloudwatch_log_group": {"l": [{"name": "x", "lifecycle": [{"prevent_destroy": true}]}]}}}
	msgs := static.deny with input as [file("m/main.tf", contents)]
	some msg in msgs
	contains(msg, "kms_key_id")
}

test_adr_0017_sns_topic_with_aws_managed_key_fails if {
	contents := {"resource": {"aws_sns_topic": {"t": [{"kms_master_key_id": "alias/aws/sns"}]}}}
	count(static.deny) == 1 with input as [file("m/main.tf", contents)]
}

test_adr_0017_sqs_queue_with_managed_sse_fails if {
	contents := {"resource": {"aws_sqs_queue": {"q": [{"sqs_managed_sse_enabled": true}]}}}
	count(static.deny) == 1 with input as [file("m/main.tf", contents)]
}

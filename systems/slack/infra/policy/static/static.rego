# Static policy on Terraform source (REQ-INFRA-008, REQ-INFRA-016, ADR-0017).
#
# Run with conftest in combined mode so rules can see sibling files:
#   conftest test --parser hcl2 --combine --namespace infra.static \
#     --policy infra/policy/static --data infra/policy/data <dir>/*.tf
#
# Input: [{"path": "<file>", "contents": <hcl2 as JSON>}, ...]
#
# The state location (DT-INFRA-003) and Tokyo independence (PROP-INFRA-002)
# checks live in tools/src (check-state-location.ts, check-dr-independence.ts)
# because they need the directory layout and module graph.
package infra.static

import rego.v1

stateful_types := {t | some t in data.stateful_types}

# resources yields [path, type, name, body] for every resource block.
resources contains [f.path, type, name, body] if {
	some f in input
	some type, blocks in object.get(f.contents, "resource", {})
	some name, instances in blocks
	some body in instances
}

# --- REQ-INFRA-016: stateful resources must set lifecycle.prevent_destroy = true.

deny contains msg if {
	some [path, type, name, body] in resources
	type in stateful_types
	not prevent_destroy(body)
	msg := sprintf("%s: %s.%s must set lifecycle { prevent_destroy = true } (REQ-INFRA-016)", [path, type, name])
}

prevent_destroy(body) if {
	some l in body.lifecycle
	l.prevent_destroy == true
}

# --- REQ-INFRA-008: S3 native locking only; no DynamoDB.

s3_backends contains [f.path, b] if {
	some f in input
	some t in object.get(f.contents, "terraform", [])
	some b in object.get(object.get(t, "backend", {}), "s3", [])
}

deny contains msg if {
	some [path, b] in s3_backends
	b.dynamodb_table
	msg := sprintf("%s: backend \"s3\" must not set dynamodb_table; use use_lockfile = true (REQ-INFRA-008)", [path])
}

deny contains msg if {
	some [path, b] in s3_backends
	not b.use_lockfile == true
	msg := sprintf("%s: backend \"s3\" must set use_lockfile = true (REQ-INFRA-008)", [path])
}

deny contains msg if {
	some f in input
	some t in object.get(f.contents, "terraform", [])
	some kind, _ in object.get(t, "backend", {})
	kind != "s3"
	msg := sprintf("%s: backend %q is not allowed; state lives in the S3 state buckets (REQ-INFRA-007)", [f.path, kind])
}

# --- ADR-0017 / REQ-INFRA-016: storage must be encrypted with a customer managed key.

cmk_algorithms := {"aws:kms", "aws:kms:dsse"}

deny contains msg if {
	some [path, type, name, body] in resources
	type == "aws_s3_bucket_server_side_encryption_configuration"
	some r in body.rule
	some d in r.apply_server_side_encryption_by_default
	not cmk_default(d)
	msg := sprintf("%s: %s.%s must use aws:kms with a customer managed key (ADR-0017)", [path, type, name])
}

cmk_default(d) if {
	d.sse_algorithm in cmk_algorithms
	is_string(d.kms_master_key_id)
	d.kms_master_key_id != ""
	not startswith(d.kms_master_key_id, "alias/aws/")
}

# A bucket without an encryption configuration in the same directory falls back
# to SSE-S3, which is not a customer managed key.
deny contains msg if {
	some [path, type, name, _] in resources
	type == "aws_s3_bucket"
	not bucket_has_sse(dir(path), name)
	msg := sprintf("%s: aws_s3_bucket.%s has no aws_s3_bucket_server_side_encryption_configuration with a customer managed key (ADR-0017)", [path, name])
}

bucket_has_sse(d, name) if {
	some [p, type, _, body] in resources
	type == "aws_s3_bucket_server_side_encryption_configuration"
	dir(p) == d
	contains(body.bucket, sprintf("aws_s3_bucket.%s.", [name]))
}

deny contains msg if {
	some [path, type, name, body] in resources
	type == "aws_cloudwatch_log_group"
	not non_aws_key(object.get(body, "kms_key_id", ""))
	msg := sprintf("%s: aws_cloudwatch_log_group.%s must set kms_key_id to a customer managed key (ADR-0017)", [path, name])
}

deny contains msg if {
	some [path, type, name, body] in resources
	type in {"aws_sns_topic", "aws_sqs_queue"}
	not non_aws_key(object.get(body, "kms_master_key_id", ""))
	msg := sprintf("%s: %s.%s must set kms_master_key_id to a customer managed key (ADR-0017)", [path, type, name])
}

non_aws_key(k) if {
	is_string(k)
	k != ""
	not startswith(k, "alias/aws/")
}

dir(path) := concat("/", array.slice(parts, 0, count(parts) - 1)) if {
	parts := split(path, "/")
}

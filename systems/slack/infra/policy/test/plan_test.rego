# Unit tests for policy/plan (DT-INFRA-007, REQ-INFRA-001, REQ-INFRA-017).
# Run with: opa test infra/policy/plan infra/policy/data infra/policy/test -v
package infra.plan_test

import rego.v1

import data.infra.plan

rc(address, type, actions) := {
	"address": address,
	"type": type,
	"change": {"actions": actions, "before": {}, "after": {}},
}

bucket_rc(address, name, actions) := {
	"address": address,
	"type": "aws_s3_bucket",
	"change": {"actions": actions, "before": null, "after": {"bucket": name}},
}

valid_exception := {
	"file": "260926-drop-bucket.json",
	"root": "dev/ap-northeast-1/network",
	"address": "module.logs.aws_s3_bucket.this",
	"actions": ["delete"],
	"reason": "bucket replaced by the shared log bucket",
	"approved_by": {"ops": "@shoito", "dev_tech_lead": "@shoito"},
	"expires": "2026-10-01",
	"pr": 123,
}

input_with(changes, exceptions, account) := {
	"plan": {"resource_changes": changes},
	"root": "dev/ap-northeast-1/network",
	"account": account,
	"today": "2026-09-26",
	"exceptions": exceptions,
}

# --- DT-INFRA-007 #1: stateful delete with a valid exception -> success, reported.

test_dt_infra_007_row1_stateful_delete_with_valid_exception_succeeds if {
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete"])],
		[valid_exception], "dev",
	)
	res.allow
	count(res.exceptions_used) == 1
}

# --- DT-INFRA-007 #2: stateful delete / replace without a valid exception -> failure.

test_dt_infra_007_row2_stateful_delete_without_exception_fails if {
	res := plan.result with input as input_with(
		[rc("aws_kms_key.state", "aws_kms_key", ["delete"])],
		[], "dev",
	)
	not res.allow
	some msg in res.deny
	contains(msg, "aws_kms_key.state")
	contains(msg, "delete")
}

test_req_infra_017_state_bucket_replace_fails_with_address_and_replace if {
	res := plan.result with input as input_with(
		[rc("module.state.aws_s3_bucket.state", "aws_s3_bucket", ["delete", "create"])],
		[], "dev",
	)
	not res.allow
	some msg in res.deny
	contains(msg, "module.state.aws_s3_bucket.state")
	contains(msg, "replace")
}

test_dt_infra_007_row2_create_before_destroy_replace_fails if {
	res := plan.result with input as input_with(
		[rc("aws_rds_cluster.main", "aws_rds_cluster", ["create", "delete"])],
		[], "prod",
	)
	not res.allow
}

test_dt_infra_007_row2_expired_exception_is_ignored_and_warned if {
	e := object.union(valid_exception, {"expires": "2026-09-25"})
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete"])],
		[e], "dev",
	)
	not res.allow
	some w in res.warn
	contains(w, "expired")
}

test_dt_infra_007_row2_exception_longer_than_14_days_is_invalid if {
	e := object.union(valid_exception, {"expires": "2026-10-11"})
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete"])],
		[e], "dev",
	)
	not res.allow
}

test_dt_infra_007_row2_exception_with_one_approver_role_is_invalid if {
	# object.union merges nested objects, so drop approved_by before replacing it.
	e := object.union(object.remove(valid_exception, ["approved_by"]), {"approved_by": {"ops": "@shoito"}})
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete"])],
		[e], "dev",
	)
	not res.allow
}

test_dt_infra_007_row2_exception_with_unknown_approver_is_invalid if {
	e := object.union(valid_exception, {"approved_by": {"ops": "@someone", "dev_tech_lead": "@shoito"}})
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete"])],
		[e], "dev",
	)
	not res.allow
}

test_dt_infra_007_row2_exception_for_other_root_is_invalid if {
	e := object.union(valid_exception, {"root": "prod/ap-northeast-1/network"})
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete"])],
		[e], "dev",
	)
	not res.allow
}

test_dt_infra_007_row2_exception_for_other_action_is_invalid if {
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete", "create"])],
		[valid_exception], "dev",
	)
	not res.allow
}

test_dt_infra_007_row2_exception_address_one_char_off_is_invalid if {
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.thiz", "aws_s3_bucket", ["delete"])],
		[valid_exception], "dev",
	)
	not res.allow
}

test_dt_infra_007_row2_exception_without_reason_is_invalid if {
	e := object.union(valid_exception, {"reason": " "})
	res := plan.result with input as input_with(
		[rc("module.logs.aws_s3_bucket.this", "aws_s3_bucket", ["delete"])],
		[e], "dev",
	)
	not res.allow
}

# --- DT-INFRA-007 #3: stateful forget -> warning only.

test_dt_infra_007_row3_stateful_forget_warns_but_succeeds if {
	res := plan.result with input as input_with(
		[rc("aws_cloudwatch_log_group.app", "aws_cloudwatch_log_group", ["forget"])],
		[], "dev",
	)
	res.allow
	count(res.warn) == 1
}

# --- DT-INFRA-007 #4: workloads in the management account -> failure.

test_req_infra_001_vpc_in_management_fails_with_message if {
	res := plan.result with input as input_with(
		[rc("aws_vpc.main", "aws_vpc", ["create"])],
		[], "management",
	)
	not res.allow
	some msg in res.deny
	contains(msg, "management account")
}

test_dt_infra_007_row4_ecs_and_rds_in_management_fail if {
	res := plan.result with input as input_with(
		[
			rc("aws_ecs_cluster.main", "aws_ecs_cluster", ["create"]),
			rc("aws_rds_cluster_parameter_group.p", "aws_rds_cluster_parameter_group", ["update"]),
		],
		[], "management",
	)
	count(res.deny) == 2
}

test_dt_infra_007_row4_app_bucket_in_management_fails if {
	res := plan.result with input as input_with(
		[bucket_rc("aws_s3_bucket.assets", "slack-assets", ["create"])],
		[], "management",
	)
	not res.allow
}

test_dt_infra_007_row4_state_bucket_in_management_is_allowed if {
	res := plan.result with input as input_with(
		[bucket_rc("module.state.aws_s3_bucket.state", "slack-tfstate-123456789012-ap-northeast-1", ["create"])],
		[], "management",
	)
	res.allow
}

test_dt_infra_007_row4_vpc_outside_management_is_allowed if {
	res := plan.result with input as input_with(
		[rc("aws_vpc.main", "aws_vpc", ["create"])],
		[], "dev",
	)
	res.allow
}

# --- DT-INFRA-007 #5: everything else -> success.

test_dt_infra_007_row5_non_stateful_delete_succeeds if {
	res := plan.result with input as input_with(
		[rc("aws_route.private", "aws_route", ["delete", "create"])],
		[], "prod",
	)
	res.allow
	count(res.warn) == 0
}

test_req_infra_017_moved_block_has_no_delete_and_succeeds if {
	moved := {
		"address": "module.state.aws_s3_bucket.this",
		"previous_address": "module.state.aws_s3_bucket.state",
		"type": "aws_s3_bucket",
		"change": {"actions": ["no-op"], "before": {}, "after": {}},
	}
	res := plan.result with input as input_with([moved], [], "dev")
	res.allow
}

test_dt_infra_007_empty_plan_succeeds if {
	res := plan.result with input as {"plan": {}, "root": "dev/ap-northeast-1/network", "account": "dev", "today": "2026-09-26", "exceptions": []}
	res.allow
}

# Plan policy: DT-INFRA-007 (REQ-INFRA-001, REQ-INFRA-017, PROP-INFRA-003).
#
# Input (built by tools/src/plan-policy-input.ts):
#   {
#     "plan":       <terraform show -json output>,
#     "root":       "<root module path relative to infra/live>",
#     "account":    "<account that owns the root module (DT-INFRA-003)>",
#     "today":      "YYYY-MM-DD",
#     "exceptions": [<policy/exceptions/*.json, each with a "file" field>]
#   }
#
# Data: policy/data/*.json (stateful_types, management_workload, exception_approvers).
#
# Every resource_change is evaluated top-down; the first matching row wins.
package infra.plan

import rego.v1

max_exception_days := 14

stateful_types := {t | some t in data.stateful_types}

resource_changes := object.get(input.plan, "resource_changes", [])

result := {
	"allow": count(deny) == 0,
	"deny": deny,
	"warn": warn,
	"exceptions_used": exceptions_used,
}

deny contains msg if {
	some rc in resource_changes
	decision(rc) == 2
	msg := sprintf(
		"%s: %s of a stateful resource (%s) is not allowed without a valid exception (DT-INFRA-007 #2)",
		[rc.address, action_label(rc.change.actions), rc.type],
	)
}

deny contains msg if {
	some rc in resource_changes
	decision(rc) == 4
	msg := sprintf(
		"%s: workloads must not be placed in the management account (%s, DT-INFRA-007 #4, REQ-INFRA-001)",
		[rc.address, rc.type],
	)
}

warn contains msg if {
	some rc in resource_changes
	decision(rc) == 3
	msg := sprintf(
		"%s: stateful resource (%s) is removed from state with a removed block; the object is kept but no longer managed (DT-INFRA-007 #3)",
		[rc.address, rc.type],
	)
}

warn contains msg if {
	some e in input.exceptions
	expired(e)
	msg := sprintf("%s: exception has expired on %s; delete the file", [object.get(e, "file", "?"), e.expires])
}

exceptions_used contains msg if {
	some rc in resource_changes
	decision(rc) == 1
	some e in input.exceptions
	valid_exception(rc, e)
	msg := sprintf(
		"%s: %s allowed by exception %s (approved by %s and %s, expires %s)",
		[rc.address, action_label(rc.change.actions), object.get(e, "file", "?"), e.approved_by.ops, e.approved_by.dev_tech_lead, e.expires],
	)
}

# decision returns the DT-INFRA-007 row number that applies to one resource_change.
decision(rc) := 1 if {
	stateful(rc)
	deletes(rc)
	some e in input.exceptions
	valid_exception(rc, e)
} else := 2 if {
	stateful(rc)
	deletes(rc)
} else := 3 if {
	stateful(rc)
	rc.change.actions == ["forget"]
} else := 4 if {
	management_workload(rc)
} else := 5

stateful(rc) if rc.type in stateful_types

deletes(rc) if "delete" in rc.change.actions

action_label(actions) := "replace" if {
	"delete" in actions
	"create" in actions
} else := "delete" if {
	"delete" in actions
} else := concat(",", actions)

management_workload(rc) if {
	input.account == "management"
	workload_type(rc.type)
	not allowed_management_bucket(rc)
}

workload_type(t) if t in {x | some x in data.management_workload.types}

workload_type(t) if {
	some p in data.management_workload.type_prefixes
	startswith(t, p)
}

allowed_management_bucket(rc) if {
	rc.type == "aws_s3_bucket"
	name := bucket_name(rc)
	some p in data.management_workload.allowed_bucket_prefixes
	startswith(name, p)
}

bucket_name(rc) := rc.change.after.bucket if {
	is_string(rc.change.after.bucket)
} else := rc.change.before.bucket if {
	is_string(rc.change.before.bucket)
} else := ""

valid_exception(rc, e) if {
	e.root == input.root
	e.address == rc.address
	e.actions == rc.change.actions
	is_string(e.reason)
	trim_space(e.reason) != ""
	e.approved_by.ops in {h | some h in data.exception_approvers.ops}
	e.approved_by.dev_tech_lead in {h | some h in data.exception_approvers.dev_tech_lead}
	not expired(e)
	days_until(e.expires) <= max_exception_days
}

expired(e) if days_until(e.expires) < 0

# Exceptions whose expiry cannot be parsed are treated as expired.
expired(e) if not parse_day(e.expires)

days_until(day) := (parse_day(day) - parse_day(input.today)) / ((24 * 60) * 60e9)

parse_day(day) := time.parse_ns("2006-01-02", day)

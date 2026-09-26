# DT-INFRA-005 table-driven trust policy tests (one run per row) plus the
# boundary cases of quality.md section 2.4, and PROP-INFRA-004 structure checks.
# StringLike patterns are evaluated here by converting `*` to `.*`.
#
# NOTE: the subject strings assume the customised OIDC template
# ["repo", "context", "ref"]; they are unverified until plan step 5 decodes a
# real token (quality.md 2.4). Update both main.tf and these samples then.

# Runs apply against the mock provider (no AWS calls) so computed ARNs are known.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }

  mock_resource "aws_iam_policy" {
    defaults = {
      arn = "arn:aws:iam::123456789012:policy/tf-apply-boundary"
    }
  }
}

variables {
  apply_environment  = "prod"
  state_bucket_arns  = ["arn:aws:s3:::slack-tfstate-123456789012-ap-northeast-1", "arn:aws:s3:::slack-tfstate-123456789012-ap-northeast-3"]
  state_kms_key_arns = ["arn:aws:kms:ap-northeast-1:123456789012:key/state"]
}

run "dt_infra_005_row1_other_repository_is_denied" {
  assert {
    condition = !anytrue(flatten([
      for s in [
        "repo:other/rebuilds:pull_request:ref:refs/pull/1/merge",
        "repo:shoito/rebuilds-fork:pull_request:ref:refs/pull/1/merge",
        "repo:shoito/rebuilds-fork:ref:refs/heads/main:ref:refs/heads/main",
        "repo:shoito/rebuilds-fork:environment:prod:ref:refs/heads/main",
        ] : [
        for p in jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] :
        can(regex("^${replace(replace(p, ".", "\\."), "*", ".*")}$", s))
      ]
    ]))
    error_message = "DT-INFRA-005 #1: tokens from other repositories must not assume tf-plan."
  }

  assert {
    condition = !contains([
      "repo:shoito/rebuilds-fork:environment:prod:ref:refs/heads/main",
      "repo:other/rebuilds:environment:prod:ref:refs/heads/main",
    ], jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"])
    error_message = "DT-INFRA-005 #1: tokens from other repositories must not assume tf-apply."
  }
}

run "dt_infra_005_row2_same_repository_pull_request_may_plan" {
  assert {
    condition = anytrue([
      for p in jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] :
      can(regex("^${replace(replace(p, ".", "\\."), "*", ".*")}$", "repo:shoito/rebuilds:pull_request:ref:refs/pull/42/merge"))
    ])
    error_message = "DT-INFRA-005 #2 / REQ-INFRA-013: a same-repository PR must assume tf-plan."
  }

  assert {
    condition     = jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com"
    error_message = "REQ-INFRA-013: the audience must be sts.amazonaws.com."
  }
}

run "dt_infra_005_row3_main_branch_or_environment_may_plan" {
  assert {
    condition = alltrue([
      for s in [
        "repo:shoito/rebuilds:ref:refs/heads/main:ref:refs/heads/main",
        "repo:shoito/rebuilds:environment:prod:ref:refs/heads/main",
        "repo:shoito/rebuilds:environment:platform:ref:refs/heads/main",
        ] : anytrue([
          for p in jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] :
          can(regex("^${replace(replace(p, ".", "\\."), "*", ".*")}$", s))
      ])
    ])
    error_message = "DT-INFRA-005 #3: main (branch or environment context) must assume tf-plan."
  }
}

run "dt_infra_005_row4_other_plan_requests_are_denied" {
  assert {
    condition = !anytrue(flatten([
      for s in [
        "repo:shoito/rebuilds:ref:refs/heads/feature:ref:refs/heads/feature",
        "repo:shoito/rebuilds:environment:prod:ref:refs/heads/feature",
        "repo:shoito/rebuilds:ref:refs/heads/main-2:ref:refs/heads/main-2",
        "repo:shoito/rebuilds:ref:refs/heads/main/x:ref:refs/heads/main/x",
        "repo:shoito/rebuilds:ref:refs/tags/main:ref:refs/tags/main",
        "repo:shoito/rebuilds:environment:prod:ref:refs/heads/main-2",
        "repo:shoito/rebuilds:environment:prod:ref:refs/tags/main",
        "repo:shoito/rebuilds:ref:refs/heads/gh-readonly-queue/main/pr-1-abc:ref:refs/heads/gh-readonly-queue/main/pr-1-abc",
        ] : [
        for p in jsondecode(aws_iam_role.plan.assume_role_policy).Statement[0].Condition.StringLike["token.actions.githubusercontent.com:sub"] :
        can(regex("^${replace(replace(p, ".", "\\."), "*", ".*")}$", s))
      ]
    ]))
    error_message = "DT-INFRA-005 #4: other branches, tags and main look-alikes must not assume tf-plan."
  }
}

run "dt_infra_005_row5_non_main_ref_cannot_apply" {
  assert {
    condition = !contains([
      "repo:shoito/rebuilds:pull_request:ref:refs/pull/42/merge",
      "repo:shoito/rebuilds:environment:prod:ref:refs/heads/feature",
      "repo:shoito/rebuilds:environment:prod:ref:refs/heads/main-2",
      "repo:shoito/rebuilds:environment:prod:ref:refs/heads/main/x",
      "repo:shoito/rebuilds:environment:prod:ref:refs/tags/main",
      "repo:shoito/rebuilds:ref:refs/heads/main:ref:refs/heads/main",
    ], jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"])
    error_message = "DT-INFRA-005 #5 / REQ-INFRA-013: PRs, other refs and main without the environment cannot assume tf-apply."
  }

  assert {
    condition     = !can(jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringLike)
    error_message = "DT-INFRA-005: tf-apply must use exact matching (StringEquals), never wildcards."
  }
}

run "dt_infra_005_row6_dev_environment_on_main_applies_dev" {
  variables {
    apply_environment = "dev"
  }

  assert {
    condition     = jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:shoito/rebuilds:environment:dev:ref:refs/heads/main"
    error_message = "DT-INFRA-005 #6: environment dev on main assumes dev tf-apply."
  }
}

run "dt_infra_005_row7_staging_environment_on_main_applies_staging" {
  variables {
    apply_environment = "staging"
  }

  assert {
    condition     = jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:shoito/rebuilds:environment:staging:ref:refs/heads/main"
    error_message = "DT-INFRA-005 #7: environment staging on main assumes staging tf-apply."
  }
}

run "dt_infra_005_row8_prod_environment_on_main_applies_prod" {
  assert {
    condition     = jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:shoito/rebuilds:environment:prod:ref:refs/heads/main"
    error_message = "DT-INFRA-005 #8: environment prod on main assumes prod tf-apply."
  }
}

run "dt_infra_005_row9_platform_environment_on_main_applies_foundation_accounts" {
  variables {
    apply_environment = "platform"
  }

  assert {
    condition     = jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:shoito/rebuilds:environment:platform:ref:refs/heads/main"
    error_message = "DT-INFRA-005 #9: environment platform on main assumes tf-apply of the foundation accounts."
  }
}

run "dt_infra_005_row10_mismatched_environment_is_denied" {
  variables {
    apply_environment = "dev"
  }

  assert {
    condition = !contains([
      "repo:shoito/rebuilds:environment:prod:ref:refs/heads/main",
      "repo:shoito/rebuilds:environment:Dev:ref:refs/heads/main",
      "repo:shoito/rebuilds:environment:platform:ref:refs/heads/main",
    ], jsondecode(aws_iam_role.apply.assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"])
    error_message = "DT-INFRA-005 #10: an environment for another account (or with different case) cannot assume this tf-apply."
  }
}

run "dt_infra_005_rejects_unknown_environment" {
  command = plan

  variables {
    apply_environment = "Prod"
  }

  expect_failures = [var.apply_environment]
}

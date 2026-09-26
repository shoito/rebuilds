// Generator of plan policy inputs for PROP-INFRA-003 (quality.md section 2.1).
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INFRA_DIR } from "../src/lib/paths.ts";
import type { PolicyException, PolicyInput, ResourceChange } from "../src/plan-policy.ts";
import { ACCOUNTS } from "../src/state-location.ts";

export const TODAY = "2026-09-26";

const STATEFUL: string[] = (
  JSON.parse(readFileSync(join(INFRA_DIR, "policy/data/stateful_types.json"), "utf8")) as { stateful_types: string[] }
).stateful_types;

// 20 non-stateful types, including management workload types from DT-INFRA-007 row 4.
const OTHER = [
  "aws_security_group",
  "aws_route",
  "aws_iam_role",
  "aws_iam_policy",
  "aws_vpc",
  "aws_subnet",
  "aws_route_table",
  "aws_nat_gateway",
  "aws_ecs_cluster",
  "aws_ecs_service",
  "aws_rds_cluster_parameter_group",
  "aws_lb",
  "aws_sns_topic",
  "aws_sqs_queue",
  "aws_s3_bucket_policy",
  "aws_s3_bucket_versioning",
  "aws_kms_alias",
  "aws_ssm_parameter",
  "aws_cloudwatch_event_rule",
  "aws_eip",
];

const ACTIONS: string[][] = [
  ["no-op"],
  ["create"],
  ["read"],
  ["update"],
  ["delete"],
  ["delete", "create"],
  ["create", "delete"],
  ["forget"],
];

const identifier = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
// for_each keys with Japanese text and symbols.
const forEachKey = fc.oneof(
  fc.string({ minLength: 0, maxLength: 6 }),
  fc.constantFrom("東京", "大阪/1c", "a.b", 'x"y', "キー[0]", "-", " "),
);
const instanceKey = fc.oneof(
  fc.constant(""),
  fc.nat({ max: 5 }).map((n) => `[${n}]`),
  forEachKey.map((k) => `[${JSON.stringify(k)}]`),
);

const address = (type: string) =>
  fc
    .tuple(fc.array(fc.tuple(identifier, instanceKey), { maxLength: 3 }), identifier, instanceKey)
    .map(([mods, name, key]) => [...mods.map(([m, k]) => `module.${m}${k}`), `${type}.${name}${key}`].join("."));

const bucket = fc.oneof(
  fc.constantFrom("slack-tfstate-123456789012-ap-northeast-1", "slack-cloudtrail-123456789012", "slack-assets", "tfstate-slack"),
  fc.string({ maxLength: 10 }),
);

export const resourceChange: fc.Arbitrary<ResourceChange> = fc
  .oneof(fc.constantFrom(...STATEFUL), fc.constantFrom(...OTHER))
  .chain((type) =>
    fc.record({
      address: address(type),
      type: fc.constant(type),
      actions: fc.constantFrom(...ACTIONS),
      before: fc.option(bucket.map((b) => ({ bucket: b })), { nil: null }),
      after: fc.option(bucket.map((b) => ({ bucket: b })), { nil: null }),
    }),
  )
  .map(({ address, type, actions, before, after }) => ({ address, type, change: { actions, before, after } }));

const rootFor = (account: string): fc.Arbitrary<string> =>
  account === "management"
    ? fc.constantFrom("global/organization", "global/identity-center", "management/ap-northeast-1/bootstrap")
    : account === "prod"
      ? fc.constantFrom("prod/ap-northeast-1/network", "prod/ap-northeast-3/network", "global/edge")
      : fc.constant(`${account}/ap-northeast-1/network`);

const oneCharOff = (s: string): fc.Arbitrary<string> =>
  fc.nat({ max: Math.max(0, s.length - 1) }).map((i) => {
    if (s.length === 0) return "x";
    const c = s[i] === "x" ? "y" : "x";
    return s.slice(0, i) + c + s.slice(i + 1);
  });

const dayOffset = (days: number): string => {
  const t = Date.parse(`${TODAY}T00:00:00Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
};

const approvers = fc.constantFrom<PolicyException["approved_by"]>(
  { ops: "@shoito", dev_tech_lead: "@shoito" },
  { ops: "@shoito", dev_tech_lead: "@shoito" },
  { ops: "@shoito", dev_tech_lead: "@shoito" },
  { ops: "@shoito" },
  { dev_tech_lead: "@shoito" },
  { ops: "@mallory", dev_tech_lead: "@shoito" },
  {},
);

const exceptionFor = (root: string, changes: ResourceChange[]): fc.Arbitrary<PolicyException> => {
  // Prefer stateful deletes so that exceptions actually matter.
  const protectedChanges = changes.filter((c) => STATEFUL.includes(c.type) && c.change.actions.includes("delete"));
  const target: fc.Arbitrary<ResourceChange | undefined> =
    changes.length === 0
      ? fc.constant(undefined)
      : protectedChanges.length > 0
        ? fc.oneof({ arbitrary: fc.constantFrom(...protectedChanges), weight: 3 }, { arbitrary: fc.constantFrom(...changes), weight: 1 })
        : fc.constantFrom(...changes);
  return target.chain((rc) =>
    fc.record({
      root: fc.constantFrom(root, root, root, "dev/ap-northeast-1/other"),
      address: rc
        ? fc.oneof({ arbitrary: fc.constant(rc.address), weight: 4 }, { arbitrary: oneCharOff(rc.address), weight: 1 })
        : identifier,
      actions: rc
        ? fc.oneof({ arbitrary: fc.constant(rc.change.actions), weight: 4 }, { arbitrary: fc.constantFrom(...ACTIONS), weight: 1 })
        : fc.constantFrom(...ACTIONS),
      reason: fc.constantFrom("approved cleanup", "approved cleanup", "approved cleanup", " ", ""),
      approved_by: approvers,
      // Boundaries of the validity window (expired yesterday, today, 14 and 15 days) are weighted up.
      expires: fc.oneof(
        { arbitrary: fc.constantFrom(-1, 0, 14, 15).map(dayOffset), weight: 3 },
        { arbitrary: fc.integer({ min: -5, max: 20 }).map(dayOffset), weight: 2 },
        { arbitrary: fc.constantFrom("2026-9-30", "someday"), weight: 1 },
      ),
      pr: fc.nat({ max: 999 }),
    }),
  );
};

export const policyInput: fc.Arbitrary<PolicyInput> = fc
  .record({
    account: fc.constantFrom(...ACCOUNTS),
    changes: fc.array(resourceChange, { maxLength: 30 }),
  })
  .chain(({ account, changes }) =>
    rootFor(account).chain((root) =>
      fc.array(exceptionFor(root, changes), { maxLength: 5 }).map((exceptions) => ({
        plan: { resource_changes: changes },
        root,
        account,
        today: TODAY,
        exceptions: exceptions.map((e, i) => ({ ...e, file: `26092${i}-generated.json` })),
      })),
    ),
  );

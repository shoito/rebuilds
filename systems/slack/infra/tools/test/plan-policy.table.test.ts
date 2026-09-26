// DT-INFRA-007 table-driven tests. Rows are read from spec.md; each row has one
// case that is checked against both the reference implementation and opa.
// Also REQ-INFRA-017 / REQ-INFRA-001 scenarios on plan JSON fixtures produced by
// real `terraform show -json` output (see policy/test/fixtures/plan).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INFRA_DIR } from "../src/lib/paths.ts";
import { plain, readDecisionTable } from "../src/lib/spec-table.ts";
import { type PlanJson, type PolicyInput, buildInput, evaluateWithOpa } from "../src/plan-policy.ts";
import { loadPolicyData, referenceAllow, referenceRow } from "../src/plan-policy-reference.ts";

const data = loadPolicyData();
const TODAY = "2026-09-26";

const exception = {
  file: "260926-example.json",
  root: "dev/ap-northeast-1/network",
  address: "aws_s3_bucket.logs",
  actions: ["delete"],
  reason: "moved to the shared log bucket",
  approved_by: { ops: "@shoito", dev_tech_lead: "@shoito" },
  expires: "2026-10-03",
  pr: 1,
};

const input = (account: string, root: string, rc: PolicyInput["plan"]["resource_changes"], exceptions = [] as (typeof exception)[]): PolicyInput => ({
  plan: { resource_changes: rc },
  root,
  account,
  today: TODAY,
  exceptions,
});

const rc = (address: string, type: string, actions: string[], after: unknown = {}) => ({
  address,
  type,
  change: { actions, before: {}, after },
});

// One case per DT-INFRA-007 row, keyed by the "#" column.
const cases: Record<number, { typeCell: string; input: PolicyInput; allow: boolean }> = {
  1: {
    typeCell: "状態を持つ型",
    input: input("dev", "dev/ap-northeast-1/network", [rc("aws_s3_bucket.logs", "aws_s3_bucket", ["delete"])], [exception]),
    allow: true,
  },
  2: {
    typeCell: "状態を持つ型",
    input: input("dev", "dev/ap-northeast-1/network", [rc("aws_kms_key.k", "aws_kms_key", ["create", "delete"])]),
    allow: false,
  },
  3: {
    typeCell: "状態を持つ型",
    input: input("dev", "dev/ap-northeast-1/network", [rc("aws_cloudwatch_log_group.l", "aws_cloudwatch_log_group", ["forget"])]),
    allow: true,
  },
  4: {
    typeCell: "-",
    input: input("management", "global/organization", [rc("aws_vpc.main", "aws_vpc", ["create"])]),
    allow: false,
  },
  5: {
    typeCell: "-",
    input: input("prod", "prod/ap-northeast-1/network", [rc("aws_route.r", "aws_route", ["delete", "create"])]),
    allow: true,
  },
};

describe("DT-INFRA-007: plan policy decision table", () => {
  const table = readDecisionTable("DT-INFRA-007");

  it("DT-INFRA-007: every row in spec.md has exactly one case", () => {
    expect(table.rows.map((r) => r.no)).toEqual(Object.keys(cases).map(Number));
  });

  for (const row of table.rows) {
    const c = cases[row.no]!;
    const expectedResult = plain(row.cells[row.cells.length - 1]!);
    it(`DT-INFRA-007 #${row.no}: ${plain(row.cells[1]!)} / ${plain(row.cells[2]!)} -> ${expectedResult}`, () => {
      expect(plain(row.cells[1]!)).toBe(c.typeCell);
      expect(expectedResult.startsWith("失敗")).toBe(!c.allow);
      const target = c.input.plan.resource_changes![0]!;
      expect(referenceRow(target, c.input, data)).toBe(row.no);
      expect(referenceAllow(c.input, data)).toBe(c.allow);
      const result = evaluateWithOpa(c.input);
      expect(result.allow).toBe(c.allow);
      if (row.no === 1) expect(result.exceptions_used).toHaveLength(1);
      if (row.no === 3) expect(result.warn).toHaveLength(1);
    });
  }
});

describe("REQ-INFRA-017 / REQ-INFRA-001: plan JSON fixtures", () => {
  const fixture = (name: string): PlanJson =>
    JSON.parse(readFileSync(join(INFRA_DIR, "policy/test/fixtures/plan", name), "utf8")) as PlanJson;

  it("REQ-INFRA-017: replacing the state bucket fails and reports the address and replace", () => {
    const result = evaluateWithOpa(buildInput("dev/ap-northeast-1/bootstrap", fixture("state-bucket-replace.json"), TODAY, []));
    expect(result.allow).toBe(false);
    expect(result.deny.join("\n")).toContain("module.state.aws_s3_bucket.state: replace");
  });

  it("REQ-INFRA-017: renaming the state bucket address with a moved block passes", () => {
    const result = evaluateWithOpa(buildInput("dev/ap-northeast-1/bootstrap", fixture("state-bucket-moved.json"), TODAY, []));
    expect(result.allow).toBe(true);
  });

  it("REQ-INFRA-017: an approved exception allows the delete and is reported", () => {
    const plan = fixture("state-bucket-replace.json");
    const e = { ...exception, root: "dev/ap-northeast-1/bootstrap", address: "module.state.aws_s3_bucket.state", actions: ["delete", "create"] };
    const result = evaluateWithOpa(buildInput("dev/ap-northeast-1/bootstrap", plan, TODAY, [e]));
    expect(result.allow).toBe(true);
    expect(result.exceptions_used.join("\n")).toContain("260926-example.json");
  });

  it("DT-INFRA-007 #3: forgetting the state bucket with a removed block only warns", () => {
    const result = evaluateWithOpa(buildInput("dev/ap-northeast-1/bootstrap", fixture("state-bucket-forget.json"), TODAY, []));
    expect(result.allow).toBe(true);
    expect(result.warn).toHaveLength(1);
  });

  it("REQ-INFRA-001: a VPC in the management account fails with the management message", () => {
    const result = evaluateWithOpa(buildInput("global/organization", fixture("management-vpc.json"), TODAY, []));
    expect(result.allow).toBe(false);
    expect(result.deny.join("\n")).toContain("must not be placed in the management account");
  });
});

// REQ-INFRA-014: per-root plan summary for the PR comment.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INFRA_DIR } from "../src/lib/paths.ts";
import type { PlanJson } from "../src/plan-policy.ts";
import { countChanges, marker, renderSummary } from "../src/plan-summary.ts";

const plan: PlanJson = {
  resource_changes: [
    { address: "aws_vpc.this", type: "aws_vpc", change: { actions: ["create"] } },
    { address: "aws_subnet.a", type: "aws_subnet", change: { actions: ["create"] } },
    { address: "aws_route.r", type: "aws_route", change: { actions: ["update"] } },
    { address: "aws_eip.nat", type: "aws_eip", change: { actions: ["delete"] } },
    { address: "aws_s3_bucket.state", type: "aws_s3_bucket", change: { actions: ["delete", "create"] } },
    { address: "aws_kms_alias.a", type: "aws_kms_alias", change: { actions: ["no-op"] } },
  ],
};

describe("REQ-INFRA-014: plan summary", () => {
  it("REQ-INFRA-014: counts create, update, delete and replace and lists their targets", () => {
    const c = countChanges(plan);
    expect([c.create, c.update, c.delete, c.replace]).toEqual([2, 1, 1, 1]);
    expect(c.deleted).toEqual(["aws_eip.nat"]);
    expect(c.replaced).toEqual(["aws_s3_bucket.state"]);
  });

  it("REQ-INFRA-014: the comment is marked per root so each root has one comment", () => {
    const body = renderSummary("dev/ap-northeast-1/network", plan);
    expect(body.startsWith(marker("dev/ap-northeast-1/network"))).toBe(true);
    expect(body).toContain("replace: `aws_s3_bucket.state`");
    expect(body).toContain("delete: `aws_eip.nat`");
  });

  it("REQ-INFRA-017: the comment reports denied changes and used exceptions", () => {
    const body = renderSummary("dev/ap-northeast-1/network", plan, {
      allow: false,
      deny: ["aws_s3_bucket.state: replace of a stateful resource"],
      warn: [],
      exceptions_used: ["aws_eip.nat: delete allowed by exception x.json"],
    });
    expect(body).toContain("FAILED");
    expect(body).toContain("exception used");
  });

  it("REQ-INFRA-014: summarises a real terraform plan JSON", () => {
    const real = JSON.parse(readFileSync(join(INFRA_DIR, "policy/test/fixtures/plan/state-bucket-replace.json"), "utf8")) as PlanJson;
    expect(countChanges(real).replaced).toEqual(["module.state.aws_s3_bucket.state"]);
  });
});

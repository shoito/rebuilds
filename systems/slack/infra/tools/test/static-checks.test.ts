// REQ-INFRA-016 / REQ-INFRA-008 / REQ-INFRA-018: static checks fail on the
// violating fixtures in policy/test/fixtures.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { modulesWithoutTests } from "../src/check-module-tests.ts";
import { checkDirs, findInvalidSuppressions } from "../src/check-suppressions.ts";
import { INFRA_DIR } from "../src/lib/paths.ts";

const FIXTURES = join(INFRA_DIR, "policy/test/fixtures");

function conftest(dir: string): { status: number | null; output: string } {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .map((f) => join(dir, f));
  const r = spawnSync(
    "conftest",
    ["test", "--parser", "hcl2", "--combine", "--namespace", "infra.static", "--policy", join(INFRA_DIR, "policy/static"), "--data", join(INFRA_DIR, "policy/data"), "--no-color", ...files],
    { encoding: "utf8" },
  );
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

describe("REQ-INFRA-016: static checks", () => {
  it("REQ-INFRA-016: an aws_s3_bucket without prevent_destroy fails and shows the resource address", () => {
    const r = conftest(join(FIXTURES, "static/missing-prevent-destroy"));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("aws_s3_bucket.logs must set lifecycle { prevent_destroy = true }");
  });

  it("REQ-INFRA-016: a checkov:skip without a reason fails", () => {
    const v = checkDirs([join(FIXTURES, "static/checkov-skip-without-reason")]);
    expect(v).toHaveLength(1);
    expect(v[0]!.check).toBe("CKV_AWS_144");
  });

  it("REQ-INFRA-016: a checkov:skip with a reason but no approvers fails", () => {
    expect(findInvalidSuppressions("#checkov:skip=CKV_AWS_144:state is per region", "x.tf")).toHaveLength(1);
  });

  it("REQ-INFRA-016: a checkov:skip with a reason and both approvers passes", () => {
    const line = "  #checkov:skip=CKV_AWS_144:state is per region approved-by:@ops-lead,@dev-lead";
    expect(findInvalidSuppressions(line, "x.tf")).toHaveLength(0);
  });
});

describe("REQ-INFRA-008: S3 native locking only", () => {
  it("REQ-INFRA-008: a backend with dynamodb_table fails the static check", () => {
    const r = conftest(join(FIXTURES, "static/dynamodb-backend"));
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("must not set dynamodb_table");
  });
});

describe("REQ-INFRA-018: every module has terraform tests", () => {
  it("REQ-INFRA-018: a module without tests/ is reported", () => {
    expect(modulesWithoutTests(join(FIXTURES, "modules-missing-tests"))).toEqual(["foo"]);
  });

  it("REQ-INFRA-018: the CLI exits non-zero for a module without tests/", () => {
    const r = spawnSync("node", [join(INFRA_DIR, "tools/src/check-module-tests.ts"), join(FIXTURES, "modules-missing-tests")], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("modules/foo has no tests");
  });
});

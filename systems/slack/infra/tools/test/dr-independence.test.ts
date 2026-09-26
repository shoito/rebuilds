// PROP-INFRA-002 / REQ-INFRA-009: disaster recovery roots do not depend on Tokyo.
import fc from "fast-check";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAll, checkDrRoot } from "../src/check-dr-independence.ts";
import { INFRA_DIR } from "../src/lib/paths.ts";

const REGIONS = ["ap-northeast-1", "ap-northeast-3", "us-east-1", "ap-southeast-1"];

type Ref =
  | { kind: "backend"; region: string }
  | { kind: "provider"; region: string | undefined; alias: string }
  | { kind: "ssm"; alias: string }
  | { kind: "remote_state"; region: string }
  | { kind: "endpoint"; region: string }
  | { kind: "module"; region: string; depth: number }
  | { kind: "comment"; region: string };

const ref: fc.Arbitrary<Ref> = fc.oneof(
  fc.record({ kind: fc.constant("backend" as const), region: fc.constantFrom(...REGIONS) }),
  fc.record({
    kind: fc.constant("provider" as const),
    region: fc.option(fc.constantFrom(...REGIONS), { nil: undefined }),
    alias: fc.stringMatching(/^[a-z]{1,6}$/),
  }),
  fc.record({ kind: fc.constant("ssm" as const), alias: fc.stringMatching(/^[a-z]{1,6}$/) }),
  fc.record({ kind: fc.constant("remote_state" as const), region: fc.constantFrom(...REGIONS) }),
  fc.record({ kind: fc.constant("endpoint" as const), region: fc.constantFrom(...REGIONS) }),
  fc.record({ kind: fc.constant("module" as const), region: fc.constantFrom(...REGIONS), depth: fc.integer({ min: 1, max: 2 }) }),
  fc.record({ kind: fc.constant("comment" as const), region: fc.constantFrom(...REGIONS) }),
);

/** Writes a root (and nested modules) for the refs; returns whether it truly depends on Tokyo. */
function materialize(base: string, refs: Ref[]): boolean {
  const root = join(base, "live/prod/ap-northeast-3/network");
  mkdirSync(root, { recursive: true });
  let tokyo = false;
  const blocks: string[] = [];
  refs.forEach((r, i) => {
    switch (r.kind) {
      case "backend":
        blocks.push(`terraform {\n  backend "s3" {\n    region       = "${r.region}"\n    use_lockfile = true\n  }\n}`);
        tokyo ||= r.region === "ap-northeast-1";
        break;
      case "provider":
        blocks.push(r.region ? `provider "aws" {\n  alias  = "${r.alias}${i}"\n  region = "${r.region}"\n}` : `provider "aws" {\n  alias = "${r.alias}${i}"\n}`);
        tokyo ||= r.region === "ap-northeast-1" || r.region === undefined;
        break;
      case "ssm":
        blocks.push(`data "aws_ssm_parameter" "p${i}" {\n  provider = aws.${r.alias}\n  name     = "/slack/x"\n}`);
        break;
      case "remote_state":
        blocks.push(`data "terraform_remote_state" "s${i}" {\n  backend = "s3"\n  config = {\n    region = "${r.region}"\n  }\n}`);
        tokyo ||= r.region === "ap-northeast-1";
        break;
      case "endpoint":
        blocks.push(`locals {\n  e${i} = "https://ssm.${r.region}.amazonaws.com"\n}`);
        tokyo ||= r.region === "ap-northeast-1";
        break;
      case "module": {
        let dir = join(base, `modules/m${i}`);
        blocks.push(`module "m${i}" {\n  source = "../../../../modules/m${i}"\n}`);
        for (let d = 1; d < r.depth; d++) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "main.tf"), `module "n" {\n  source = "../m${i}n${d}"\n}\n`);
          dir = join(base, `modules/m${i}n${d}`);
        }
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "main.tf"), `locals {\n  region = "${r.region}"\n}\n`);
        tokyo ||= r.region === "ap-northeast-1";
        break;
      }
      case "comment":
        // Comments are not dependencies.
        blocks.push(`# formerly in ${r.region}`);
        break;
    }
  });
  writeFileSync(join(root, "main.tf"), `${blocks.join("\n\n")}\n`);
  return tokyo;
}

describe("PROP-INFRA-002: disaster recovery roots exclude ap-northeast-1", () => {
  it("PROP-INFRA-002: the checker reports a finding exactly when a Tokyo reference or an implicit region exists", () => {
    fc.assert(
      fc.property(fc.array(ref, { maxLength: 8 }), (refs) => {
        const base = mkdtempSync(join(tmpdir(), "dr-"));
        try {
          const expected = materialize(base, refs);
          const findings = checkAll(join(base, "live"));
          return (findings.length > 0) === expected;
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      }),
      { numRuns: 300 },
    );
  });

  it("REQ-INFRA-009: reading Tokyo SSM from prod/ap-northeast-3/network fails the check", () => {
    const root = join(INFRA_DIR, "policy/test/fixtures/live-dr-tokyo-ssm/prod/ap-northeast-3/network");
    const findings = checkDrRoot(root);
    expect(findings.map((f) => f.message).join("\n")).toContain("ap-northeast-1");
  });

  it("PROP-INFRA-002: the real disaster recovery roots have no Tokyo dependency", () => {
    expect(checkAll(join(INFRA_DIR, "live"))).toEqual([]);
  });
});

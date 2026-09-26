// DT-INFRA-003 table-driven tests (rows read from spec.md) and REQ-INFRA-007 scenarios.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkRoot } from "../src/check-state-location.ts";
import { INFRA_DIR } from "../src/lib/paths.ts";
import { plain, readDecisionTable } from "../src/lib/spec-table.ts";
import { ACCOUNTS, type AccountsFile, stateLocation } from "../src/state-location.ts";

const REGION: Record<string, string> = { 東京: "ap-northeast-1", 大阪: "ap-northeast-3" };

/** Concrete root paths that match a path pattern of the table. */
function samples(pattern: string): { root: string; account?: string }[] {
  if (pattern.includes("<account>")) {
    return ACCOUNTS.map((a) => ({ root: pattern.replace("<account>", a).replace("*", "network"), account: a }));
  }
  if (pattern === "それ以外") {
    return [{ root: "dev/us-east-1/network" }, { root: "sandbox/ap-northeast-1/network" }, { root: "prod/ap-northeast-3" }, { root: "global" }];
  }
  return [{ root: pattern.replace("*", "network") }];
}

describe("DT-INFRA-003: state location", () => {
  const table = readDecisionTable("DT-INFRA-003");

  it("DT-INFRA-003: the table has the five rows the implementation evaluates", () => {
    expect(table.rows.map((r) => r.no)).toEqual([1, 2, 3, 4, 5]);
  });

  for (const row of table.rows) {
    const [, pathCell, accountCell, regionCell] = row.cells.map(plain);
    const pattern = pathCell!.replace(/（.*）$/, "").trim();
    for (const s of samples(pattern)) {
      it(`DT-INFRA-003 #${row.no}: ${s.root} -> ${accountCell} / ${regionCell}`, () => {
        const loc = stateLocation(s.root);
        expect(loc.row).toBe(row.no);
        if (row.no === 5) {
          expect(loc.ok).toBe(false);
          return;
        }
        expect(loc.ok).toBe(true);
        if (!loc.ok) return;
        expect(loc.account).toBe(accountCell === "<account>" ? s.account : accountCell);
        expect(loc.region).toBe(REGION[regionCell!]);
      });
    }
  }
});

describe("REQ-INFRA-007: backend must match DT-INFRA-003", () => {
  const accounts: AccountsFile = {
    organization_id: "o-example",
    account_ids: { management: "111111111111", security: null, "log-archive": null, shared: null, dev: "222222222222", staging: null, prod: "333333333333" },
  };
  const liveDir = join(INFRA_DIR, "policy/test/fixtures/live-wrong-location");

  it("REQ-INFRA-007: an Osaka root pointing at the Tokyo bucket fails and names the correct bucket", () => {
    const errors = checkRoot(liveDir, "prod/ap-northeast-3/network", accounts).join("\n");
    expect(errors).toContain('backend region is "ap-northeast-1" but must be "ap-northeast-3"');
    expect(errors).toContain('expected bucket "slack-tfstate-333333333333-ap-northeast-3"');
  });

  it("REQ-INFRA-007: the CLI exits non-zero for the wrong location", () => {
    const r = spawnSync("node", [join(INFRA_DIR, "tools/src/check-state-location.ts"), liveDir], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("slack-tfstate-");
  });

  it("REQ-INFRA-007: the real prod Osaka network root uses the prod Osaka bucket in ap-northeast-3", () => {
    expect(checkRoot(join(INFRA_DIR, "live"), "prod/ap-northeast-3/network", accounts)).toEqual([]);
  });
});

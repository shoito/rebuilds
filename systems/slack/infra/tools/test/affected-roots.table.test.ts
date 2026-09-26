// DT-INFRA-006 table-driven tests (rows read from spec.md) and REQ-INFRA-014 scenarios.
import { describe, expect, it } from "vitest";
import { type Layout, affected, readLayout, rootsUsingModule } from "../src/affected-roots.ts";
import { plain, readDecisionTable } from "../src/lib/spec-table.ts";

const P = "systems/slack/infra/";

// A synthetic layout: `inner` is used only through `outer` (indirect use).
const layout: Layout = {
  roots: ["dev/ap-northeast-1/network", "prod/ap-northeast-1/network", "prod/ap-northeast-3/network", "global/organization"],
  moduleCalls: { vpc: [], outer: ["inner"], inner: [], unused: [] },
  rootCalls: {
    "dev/ap-northeast-1/network": ["vpc"],
    "prod/ap-northeast-1/network": ["vpc", "outer"],
    "prod/ap-northeast-3/network": ["vpc"],
    "global/organization": [],
  },
};

// One case per DT-INFRA-006 row: a changed file that matches the row's path pattern and the expected result.
const cases: Record<number, { pattern: RegExp; file: string; expect: ReturnType<typeof affected> }> = {
  1: {
    pattern: /^infra\/live\/<root>\/\*\*/,
    file: `${P}live/dev/ap-northeast-1/network/.terraform.lock.hcl`,
    expect: { roots: ["dev/ap-northeast-1/network"], moduleTests: [], static: true, policyTests: false },
  },
  2: {
    pattern: /^infra\/modules\/<m>\/\*\*/,
    file: `${P}modules/inner/main.tf`,
    expect: { roots: ["prod/ap-northeast-1/network"], moduleTests: ["inner"], static: true, policyTests: false },
  },
  3: {
    pattern: /^infra\/policy\/\*\*/,
    file: `${P}policy/plan/plan.rego`,
    expect: { roots: [], moduleTests: [], static: false, policyTests: true },
  },
  4: {
    pattern: /infra\/\.tflint\.hcl/,
    file: `${P}.tflint.hcl`,
    expect: { roots: [...layout.roots].sort(), moduleTests: [], static: true, policyTests: false },
  },
  5: {
    pattern: /^\.github\/workflows\/infra-\*\.yml/,
    file: ".github/workflows/infra-drift.yml",
    expect: { roots: [...layout.roots].sort(), moduleTests: [], static: false, policyTests: false },
  },
  6: {
    pattern: /^それ以外/,
    file: "systems/slack/docs/intent.md",
    expect: { roots: [], moduleTests: [], static: false, policyTests: false },
  },
};

describe("DT-INFRA-006: root modules to plan", () => {
  const table = readDecisionTable("DT-INFRA-006");

  it("DT-INFRA-006: every row in spec.md has exactly one case", () => {
    expect(table.rows.map((r) => r.no)).toEqual(Object.keys(cases).map(Number));
  });

  for (const row of table.rows) {
    const c = cases[row.no]!;
    it(`DT-INFRA-006 #${row.no}: ${plain(row.cells[1]!)} -> ${plain(row.cells[2]!)}`, () => {
      expect(plain(row.cells[1]!)).toMatch(c.pattern);
      expect(affected([c.file], layout)).toEqual(c.expect);
    });
  }

  it("DT-INFRA-006 #4: .terraform-version and .checkov.yaml also plan every root", () => {
    for (const f of [".terraform-version", ".checkov.yaml"]) {
      expect(affected([`${P}${f}`], layout).roots).toHaveLength(layout.roots.length);
    }
  });

  it("DT-INFRA-006: results of several files are unioned", () => {
    const r = affected([`${P}live/global/organization/main.tf`, `${P}modules/vpc/main.tf`, `${P}policy/data/stateful_types.json`], layout);
    expect(r.roots).toEqual(["dev/ap-northeast-1/network", "global/organization", "prod/ap-northeast-1/network", "prod/ap-northeast-3/network"]);
    expect(r.moduleTests).toEqual(["vpc"]);
    expect(r.policyTests).toBe(true);
  });

  it("DT-INFRA-006 #2: a module nobody uses plans no root but still runs its tests", () => {
    expect(affected([`${P}modules/unused/main.tf`], layout)).toEqual({ roots: [], moduleTests: ["unused"], static: true, policyTests: false });
  });
});

describe("REQ-INFRA-014: affected roots on the real layout", () => {
  const real = readLayout();

  it("REQ-INFRA-014: changing only dev network main.tf plans only dev network", () => {
    expect(affected([`${P}live/dev/ap-northeast-1/network/main.tf`], real).roots).toEqual(["dev/ap-northeast-1/network"]);
  });

  it("REQ-INFRA-014: changing modules/vpc plans the four network roots", () => {
    expect(rootsUsingModule("vpc", real)).toEqual([
      "dev/ap-northeast-1/network",
      "prod/ap-northeast-1/network",
      "prod/ap-northeast-3/network",
      "staging/ap-northeast-1/network",
    ]);
    expect(affected([`${P}modules/vpc/main.tf`], real).roots).toHaveLength(4);
  });
});

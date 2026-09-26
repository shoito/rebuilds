import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { classifyPath, definedScripts, missingHooks, planJobs, type Hook } from "../src/changes.ts";
import { fixtureMonorepo, slackConfig, TempRepo } from "./monorepo.ts";
import { loadTable } from "./support.ts";

const table = loadTable("DT-DLV-001");

/** Example paths for the backticked globs of a DT-DLV-001 path cell. */
function samplePaths(cell: string): string[] {
  const globs = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  return globs.flatMap((g) => {
    const brace = /\{([^}]+)\}/.exec(g);
    const expanded = brace ? brace[1]!.split(",").map((alt) => g.replace(brace[0], alt)) : [g];
    return expanded.map((p) => p.replace("systems/*/", "systems/slack/").replace("**", "sub/file.ts"));
  });
}

const scopeOf = (cell: string) => (cell.startsWith("全") ? "all" : cell.startsWith("変更のあった") ? "affected" : "none");

describe("DT-DLV-001: changed paths and checks", () => {
  it.each(table.rows.map((r) => [r[0]!, r]))("DT-DLV-001 #%s", (row, cells) => {
    const [, pathCell, slackCell, hookCell, otherCell] = cells;
    const paths = samplePaths(pathCell!);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      const d = classifyPath(p);
      expect(d.row, p).toBe(Number(row));
      expect(d.slack, p).toBe(scopeOf(slackCell!));
      const required = [...hookCell!.matchAll(/`([a-z:]+)`/g)].map((m) => m[1] as Hook);
      if (hookCell!.includes("タスクが必須")) {
        expect(d.requiredHooks, p).toEqual(required);
        expect(d.hooks, p).not.toBe("none");
      } else {
        expect(d.requiredHooks, p).toEqual([]);
        expect(d.hooks, p).toBe(scopeOf(hookCell!.includes("定義されているフック") ? "変更のあった" : hookCell!));
      }
      const expectedOther = [
        otherCell!.includes("ワークフローの安全性") && "workflow-lint",
        otherCell!.includes("ruleset") && "ruleset",
        (otherCell!.startsWith("インフラ") || (otherCell!.includes("infra-") && p.includes("/infra-"))) && "infra",
        otherCell!.includes("tools/") && "tools-test",
        otherCell!.includes("eval") && "agent-eval",
      ].filter(Boolean);
      expect(d.other, p).toEqual(expectedOther);
    }
  });

  it("DT-DLV-001: rows match on path boundaries", () => {
    expect(classifyPath(".github/workflows/infra-pr.yml").other).toContain("infra");
    expect(classifyPath(".github/workflowsx/a.yml").row).toBe(10);
    expect(classifyPath("systems/slack/apps/api/package.json").row).toBe(6);
    expect(classifyPath("systems/slack/packages/db/migrations2/a.sql").row).toBe(6);
    expect(classifyPath("systems/slack/packages/contracts/a.ts").row).toBe(6);
    expect(classifyPath("systems/slack/docs/AGENTS.md").row).toBe(10);
    expect(classifyPath("systems/slack/CLAUDE.md").row).toBe(10);
    expect(classifyPath("toolsx/a.ts").row).toBe(10);
  });
});

describe("REQ-DLV-003, REQ-DLV-004: jobs to run", () => {
  it("REQ-DLV-004: spec-checks and changes are always targets; an empty change runs nothing else (Q9)", () => {
    expect(planJobs([], true).targets).toEqual(["changes", "spec-checks"]);
  });

  it("REQ-DLV-003: a documentation-only change runs only the spec checks", () => {
    expect(planJobs(["systems/slack/docs/architecture/realtime.md"], true)).toEqual({
      targets: ["changes", "spec-checks"],
      slack: "none",
      hooks: "none",
      requiredHooks: [],
    });
  });

  it("REQ-DLV-003: the infra job is a target only once infra-pr.yml exists", () => {
    expect(planJobs(["systems/slack/infra/envs/dev/main.tf"], false).targets).not.toContain("infra");
    expect(planJobs(["systems/slack/infra/envs/dev/main.tf"], true).targets).toContain("infra");
  });
});

describe("REQ-DLV-003: affected packages in the fixture monorepo", () => {
  let repo: TempRepo | undefined;
  afterEach(() => repo?.remove());

  const change = (path: string) => {
    repo = new TempRepo(fixtureMonorepo());
    const base = repo.git("rev-parse", "HEAD").trim();
    repo.write(new Map([[path, "// changed\n"]]));
    repo.commit("change");
    return repo.checkedPackages(base, ["typecheck", "lint", "test"]);
  };

  it("REQ-DLV-003: a change in a leaf package checks only that package", () => {
    expect(change("systems/slack/apps/api/src/app.ts")).toEqual(["@slack/api"]);
  });

  it("REQ-DLV-003: a change in a depended-on package also checks its dependents", () => {
    expect(change("systems/slack/packages/contract/src/messages.ts")).toEqual(["@slack/api", "@slack/contract"]);
  });

  it("REQ-DLV-003: a change in the root configuration checks every package", () => {
    expect(change("systems/slack/pnpm-lock.yaml")).toEqual(["@slack/api", "@slack/contract", "@slack/db"]);
  });

  it("REQ-DLV-003: a documentation-only change checks no package", () => {
    expect(change("systems/slack/docs/architecture/realtime.md")).toEqual([]);
  });
});

describe("REQ-DLV-011: hooks for later stories", () => {
  let repo: TempRepo | undefined;
  afterEach(() => repo?.remove());

  const withMigration = (defineLint: boolean) => {
    const files = fixtureMonorepo();
    if (defineLint) {
      const db = JSON.parse(files.get("systems/slack/packages/db/package.json")!);
      db.scripts["lint:migrations"] = "true";
      files.set("systems/slack/packages/db/package.json", JSON.stringify(db));
    }
    repo = new TempRepo(files);
    const base = repo.git("rev-parse", "HEAD").trim();
    repo.write(new Map([["systems/slack/packages/db/migrations/0002_x.sql", "select 1;\n"]]));
    repo.commit("migration");
    const paths = repo.git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
    return { base, plan: planJobs(paths, false), scripts: definedScripts(`${repo.dir}/systems/slack`) };
  };

  it("REQ-DLV-011: a hook that no package defines succeeds without doing anything", () => {
    repo = new TempRepo(fixtureMonorepo());
    const base = repo.git("rev-parse", "HEAD").trim();
    repo.write(new Map([["systems/slack/apps/api/src/app.ts", "// changed\n"]]));
    repo.commit("change");
    const plan = planJobs(["systems/slack/apps/api/src/app.ts"], false);
    expect(missingHooks(plan.requiredHooks, definedScripts(`${repo.dir}/systems/slack`))).toEqual([]);
    expect(repo.turbo(["check:contract"], base, true)).toEqual([]);
  });

  it("REQ-DLV-011: a migration with a defined lint task runs the task", () => {
    const { base, plan, scripts } = withMigration(true);
    expect(plan.requiredHooks).toEqual(["lint:migrations"]);
    expect(missingHooks(plan.requiredHooks, scripts)).toEqual([]);
    expect(repo!.turbo(["lint:migrations"], base, true)).toEqual(["@slack/db"]);
  });

  it("REQ-DLV-011: a migration without any lint task fails and says the migration lint task is missing", () => {
    const { plan, scripts } = withMigration(false);
    expect(missingHooks(plan.requiredHooks, scripts)).toEqual([expect.stringContaining("migration lint task")]);
  });
});

/** Random acyclic workspace: package i may depend only on packages < i (quality.md 2.1). */
const workspaceArb = fc
  .integer({ min: 2, max: 25 })
  .chain((n) =>
    fc.record({
      n: fc.constant(n),
      density: fc.double({ min: 0, max: 0.4, noNaN: true }),
      edges: fc.array(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: n, maxLength: n }), { minLength: n, maxLength: n }),
      changes: fc.array(
        fc.oneof(
          fc.record({ kind: fc.constant("src" as const), pkg: fc.nat(n - 1) }),
          fc.record({ kind: fc.constant("test" as const), pkg: fc.nat(n - 1) }),
          fc.record({ kind: fc.constant("manifest" as const), pkg: fc.nat(n - 1) }),
          fc.record({ kind: fc.constantFrom("root" as const), file: fc.constantFrom("package.json", "pnpm-workspace.yaml", "turbo.json", "tsconfig.base.json") }),
          fc.record({ kind: fc.constant("docs" as const) }),
          fc.record({ kind: fc.constant("other" as const) }),
        ),
        { maxLength: 10 },
      ),
    }),
  );

describe("PROP-DLV-001", () => {
  it("PROP-DLV-001: the checked packages include every changed package and all its dependents", () => {
    fc.assert(
      fc.property(workspaceArb, ({ n, density, edges, changes }) => {
        const name = (i: number) => `p${String(i).padStart(2, "0")}`;
        const deps = Array.from({ length: n }, (_, i) => Array.from({ length: i }, (_, j) => j).filter((j) => edges[i]![j]! < density));
        const files = slackConfig();
        for (let i = 0; i < n; i++) {
          const dependencies = Object.fromEntries(deps[i]!.map((j) => [name(j), "workspace:*"]));
          files.set(`systems/slack/packages/${name(i)}/package.json`, JSON.stringify({ name: name(i), scripts: { test: "true" }, dependencies }));
          files.set(`systems/slack/packages/${name(i)}/src/index.ts`, "export {};\n");
        }
        const repo = new TempRepo(files);
        try {
          const base = repo.git("rev-parse", "HEAD").trim();
          const changed = new Map<string, string>();
          const direct = new Set<number>();
          let all = false;
          changes.forEach((c, k) => {
            if (c.kind === "src") changed.set(`systems/slack/packages/${name(c.pkg)}/src/f${k}.ts`, "export {};\n");
            if (c.kind === "test") changed.set(`systems/slack/packages/${name(c.pkg)}/test/f${k}.test.ts`, "export {};\n");
            if (c.kind === "manifest") {
              const path = `systems/slack/packages/${name(c.pkg)}/package.json`;
              const pkg = JSON.parse(changed.get(path) ?? files.get(path)!);
              changed.set(path, JSON.stringify({ ...pkg, description: `v${k}` }));
            }
            if (c.kind === "root") {
              const path = `systems/slack/${c.file}`;
              changed.set(path, `${changed.get(path) ?? files.get(path) ?? "{}"}\n`);
              all = true;
            }
            if (c.kind === "docs") changed.set(`systems/slack/docs/f${k}.md`, "x\n");
            if (c.kind === "other") changed.set(`README${k}.md`, "x\n");
            if (c.kind === "src" || c.kind === "test" || c.kind === "manifest") direct.add(c.pkg);
          });
          repo.write(changed);
          repo.commit("change");

          // Reference: reverse transitive closure of the changed packages (all packages for root files).
          const expected = new Set<number>(all ? Array.from({ length: n }, (_, i) => i) : direct);
          for (let grew = true; grew; ) {
            grew = false;
            for (let i = 0; i < n; i++) {
              if (!expected.has(i) && deps[i]!.some((j) => expected.has(j))) {
                expected.add(i);
                grew = true;
              }
            }
          }
          const checked = repo.checkedPackages(base);
          for (const i of expected) expect(checked, name(i)).toContain(name(i));
        } finally {
          repo.remove();
        }
      }),
      { numRuns: 100 },
    );
  });
});

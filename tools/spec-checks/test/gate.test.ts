import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { HOOKS, planJobs } from "../src/changes.ts";
import { evaluateGate, judge, type GateFacts, type Needs } from "../src/gate.ts";
import { combinations, firstRow, loadTable, ROOT } from "./support.ts";

const table = loadTable("DT-DLV-002");

type Facts = GateFacts & { nonTargetNotSuccess: boolean };
const KEYS: (keyof Facts)[] = ["failure", "cancelled", "skipped", "nonTargetNotSuccess"];

describe("DT-DLV-002: ci-gate", () => {
  const all = combinations({ failure: [false, true], cancelled: [false, true], skipped: [false, true], nonTargetNotSuccess: [false, true] });
  it.each(table.rows.map((r) => [r[0]!, r]))("DT-DLV-002 #%s", (row, cells) => {
    const cases = all.filter((f) => firstRow(table, [1, 2, 3, 4], f, (cell, col, x) => (cell === "はい") === x[KEYS[col - 1]!])![0] === row);
    expect(cases.length).toBeGreaterThan(0);
    for (const f of cases) {
      expect(evaluateGate(f), JSON.stringify(f)).toEqual({ row: Number(row), pass: cells.at(-1)!.startsWith("成功") });
    }
  });
});

const needs = (targets: string[], results: Record<string, string>): Needs => ({
  changes: { result: results.changes ?? "success", outputs: { targets: JSON.stringify(targets) } },
  ...Object.fromEntries(Object.entries(results).filter(([k]) => k !== "changes").map(([k, v]) => [k, { result: v }])),
});

describe("REQ-DLV-004: ci-gate", () => {
  it("REQ-DLV-004: a docs-only PR passes when the spec checks pass (skipped jobs are not targets)", () => {
    const r = judge(needs(["changes", "spec-checks"], { "slack-test": "skipped", "slack-static": "skipped", "spec-checks": "success" }));
    expect(r).toMatchObject({ pass: true, row: 4 });
  });

  it("REQ-DLV-004: one failed check fails the gate and names it in the summary", () => {
    const r = judge(
      needs(["changes", "spec-checks", "slack-integration"], { "slack-integration": "failure", "spec-checks": "success" }),
    );
    expect(r.pass).toBe(false);
    expect(r.summary).toContain("Failed checks: slack-integration");
  });

  it("REQ-DLV-004: a target that did not run fails the gate", () => {
    expect(judge(needs(["changes", "slack-test"], { "slack-test": "skipped" }))).toMatchObject({ pass: false, row: 3 });
  });

  it("REQ-DLV-004: if the changes job fails, every job is a target (Q8)", () => {
    const r = judge({ changes: { result: "failure", outputs: {} }, "slack-test": { result: "skipped" }, "spec-checks": { result: "success" } });
    expect(r).toMatchObject({ pass: false, row: 1 });
  });

  const ci = () =>
    parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      on: Record<string, unknown>;
      env: Record<string, string>;
      jobs: Record<string, { needs?: string[]; if?: string }>;
    };

  it("REQ-DLV-005: the same CI runs for merge groups, compared with the queue base", () => {
    const wf = ci();
    expect(Object.keys(wf.on).sort()).toEqual(["merge_group", "pull_request"]);
    expect(wf.env.BASE_SHA).toContain("github.event.merge_group.base_sha");
    expect(wf.env.TURBO_SCM_BASE).toBe(wf.env.BASE_SHA);
  });

  it("REQ-DLV-004: ci-gate needs every other job of ci.yml, and every target is a job", () => {
    const wf = ci();
    const jobs = Object.keys(wf.jobs).filter((j) => j !== "ci-gate");
    expect([...wf.jobs["ci-gate"]!.needs!].sort()).toEqual(jobs.sort());
    expect(wf.jobs["ci-gate"]!.if).toContain("!cancelled()");
    const everything = planJobs(
      [".github/workflows/x.yml", ".github/rulesets/main.json", "tools/x.ts", "systems/slack/packages/db/migrations/1.sql"],
      false,
    );
    for (const t of everything.targets) expect(jobs).toContain(t);
    for (const h of HOOKS) expect(JSON.stringify(wf.jobs)).toContain(h);
  });
});

// REQ-DLV-003, REQ-DLV-011 (DT-DLV-001): which CI jobs run for a set of changed files.
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Scope = "none" | "affected" | "all";
export type Hook = "lint:migrations" | "check:contract" | "test:flags";
export const HOOKS: Hook[] = ["lint:migrations", "check:contract", "test:flags"];
export type Other = "workflow-lint" | "ruleset" | "infra" | "tools-test" | "agent-eval";

export interface PathDecision {
  row: number;
  slack: Scope;
  hooks: Scope;
  requiredHooks: Hook[];
  other: Other[];
}

const SLACK_ROOT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "turbo.json", "tsconfig.base.json"];

/** DT-DLV-001 for one path (relative to the repository root); first matching row wins. */
export function classifyPath(path: string): PathDecision {
  const d = (row: number, slack: Scope, hooks: Scope, requiredHooks: Hook[], other: Other[]): PathDecision => ({
    row,
    slack,
    hooks,
    requiredHooks,
    other,
  });
  if (/^\.github\/(workflows|actions)\//.test(path)) {
    const infra = /^\.github\/workflows\/infra-[^/]*\.ya?ml$/.test(path);
    return d(1, "all", "all", [], infra ? ["workflow-lint", "infra"] : ["workflow-lint"]);
  }
  if (path.startsWith(".github/rulesets/")) return d(2, "none", "none", [], ["ruleset"]);
  if (SLACK_ROOT_FILES.some((f) => path === `systems/slack/${f}`)) return d(3, "all", "all", [], []);
  if (path.startsWith("systems/slack/packages/db/migrations/")) return d(4, "affected", "affected", ["lint:migrations"], []);
  if (/^systems\/slack\/packages\/(contract|api-client)\//.test(path)) {
    return d(5, "affected", "affected", ["check:contract"], []);
  }
  if (/^systems\/slack\/(apps|packages)\//.test(path)) return d(6, "affected", "affected", [], []);
  if (path.startsWith("systems/slack/infra/")) return d(7, "none", "none", [], ["infra"]);
  if (path.startsWith("tools/")) return d(8, "none", "none", [], ["tools-test"]);
  if (path === "AGENTS.md" || /^systems\/[^/]+\/AGENTS\.md$/.test(path) || path.startsWith(".claude/")) {
    return d(9, "none", "none", [], ["agent-eval"]);
  }
  return d(10, "none", "none", [], []);
}

export interface JobPlan {
  /** Jobs of ci.yml that must run (DT-DLV-002 "target jobs"). */
  targets: string[];
  slack: Scope;
  hooks: Scope;
  requiredHooks: Hook[];
}

const RANK: Record<Scope, number> = { none: 0, affected: 1, all: 2 };
const max = (a: Scope, b: Scope): Scope => (RANK[a] >= RANK[b] ? a : b);

/**
 * Union of DT-DLV-001 over all changed files. `infraWorkflow` is false while
 * .github/workflows/infra-pr.yml does not exist (260926-terraform-foundation), in
 * which case the infra job is not a target.
 */
export function planJobs(paths: string[], infraWorkflow: boolean): JobPlan {
  let slack: Scope = "none";
  let hooks: Scope = "none";
  const required = new Set<Hook>();
  const other = new Set<Other>();
  for (const p of paths) {
    const r = classifyPath(p);
    slack = max(slack, r.slack);
    hooks = max(hooks, r.hooks);
    r.requiredHooks.forEach((h) => required.add(h));
    r.other.forEach((o) => other.add(o));
  }
  // The spec checks (REQ-DLV-006..010) and the title check run for every PR.
  const targets = ["changes", "spec-checks"];
  if (slack !== "none") targets.push("slack-static", "slack-test", "slack-integration");
  if (hooks !== "none") targets.push("slack-hooks");
  if (other.has("workflow-lint") || other.has("ruleset")) targets.push("workflow-lint");
  if (other.has("infra") && infraWorkflow) targets.push("infra");
  if (other.has("tools-test")) targets.push("tools-test");
  // "agent-eval" is a hook without content yet (DT-DLV-001 #9): nothing to run.
  return { targets, slack, hooks, requiredHooks: HOOKS.filter((h) => required.has(h)) };
}

/** Script names defined by the packages of a pnpm workspace such as systems/slack. */
export function definedScripts(workspaceDir: string): Set<string> {
  const scripts = new Set<string>();
  for (const p of globSync("{apps,packages}/*/package.json", { cwd: workspaceDir })) {
    const pkg = JSON.parse(readFileSync(join(workspaceDir, p), "utf8")) as { scripts?: Record<string, string> };
    Object.keys(pkg.scripts ?? {}).forEach((s) => scripts.add(s));
  }
  return scripts;
}

/** REQ-DLV-011: required hook tasks must be defined by at least one package. */
export function missingHooks(required: Hook[], definedScripts: Set<string>): string[] {
  const names: Record<Hook, string> = {
    "lint:migrations": "the migration lint task (lint:migrations)",
    "check:contract": "the contract check task (check:contract)",
    "test:flags": "the flag test task (test:flags)",
  };
  return required
    .filter((h) => !definedScripts.has(h))
    .map((h) => `${names[h]} is required by the changed paths (DT-DLV-001) but no package defines it`);
}

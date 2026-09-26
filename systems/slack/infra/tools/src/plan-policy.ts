// Runs the plan policy (policy/plan, DT-INFRA-007) against `terraform show -json`.
// Usage: node src/plan-policy.ts <root> <plan.json> [--today YYYY-MM-DD] [--out result.json]
// Exit code 1 when the policy denies the plan.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { INFRA_DIR } from "./lib/paths.ts";
import { stateLocation } from "./state-location.ts";

export interface ResourceChange {
  address: string;
  type: string;
  previous_address?: string | null;
  change: { actions: string[]; before?: unknown; after?: unknown };
}

export interface PlanJson {
  resource_changes?: ResourceChange[];
}

export interface PolicyException {
  file?: string;
  root: string;
  address: string;
  actions: string[];
  reason: string;
  approved_by: { ops?: string; dev_tech_lead?: string };
  expires: string;
  pr?: number;
}

export interface PolicyInput {
  plan: PlanJson;
  root: string;
  account: string;
  today: string;
  exceptions: PolicyException[];
}

export interface PolicyResult {
  allow: boolean;
  deny: string[];
  warn: string[];
  exceptions_used: string[];
}

export const POLICY_DIRS = [join(INFRA_DIR, "policy/plan"), join(INFRA_DIR, "policy/data")];

export function loadExceptions(dir: string = join(INFRA_DIR, "policy/exceptions")): PolicyException[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ ...(JSON.parse(readFileSync(join(dir, f), "utf8")) as PolicyException), file: f }));
}

export function buildInput(root: string, plan: PlanJson, today: string, exceptions: PolicyException[]): PolicyInput {
  const loc = stateLocation(root);
  if (!loc.ok) throw new Error(loc.reason);
  return { plan, root, account: loc.account, today, exceptions };
}

export function evaluateWithOpa(input: PolicyInput): PolicyResult {
  const args = ["eval", "--format", "json", "--stdin-input", ...POLICY_DIRS.flatMap((d) => ["-d", d]), "data.infra.plan.result"];
  const out = execFileSync("opa", args, { input: JSON.stringify(input), encoding: "utf8" });
  const parsed = JSON.parse(out) as { result?: { expressions: { value: PolicyResult }[] }[] };
  const value = parsed.result?.[0]?.expressions[0]?.value;
  if (!value) throw new Error(`opa returned no result: ${out}`);
  return value;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { today: { type: "string" }, out: { type: "string" } },
  });
  const [root, planPath] = positionals;
  if (!root || !planPath) {
    console.error("usage: plan-policy.ts <root> <plan.json> [--today YYYY-MM-DD] [--out result.json]");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanJson;
  const result = evaluateWithOpa(buildInput(root, plan, values.today ?? todayUtc(), loadExceptions()));
  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2));
  for (const m of result.warn) console.log(`::warning::${root}: ${m}`);
  for (const m of result.exceptions_used) console.log(`::notice::${root}: ${m}`);
  for (const m of result.deny) console.error(`::error::${root}: ${m}`);
  if (!result.allow) process.exit(1);
  console.log(`plan policy: ${root} passed`);
}

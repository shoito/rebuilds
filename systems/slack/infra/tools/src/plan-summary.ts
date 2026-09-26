// REQ-INFRA-014: per-root plan summary (create/update/delete/replace counts and
// the delete/replace targets) posted as one PR comment per root module.
// Usage: node src/plan-summary.ts <root> <plan.json> [policy-result.json] [--post <pr-number>]
//   env for --post: GITHUB_TOKEN, GITHUB_REPOSITORY
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { PlanJson, PolicyResult } from "./plan-policy.ts";

export interface PlanCounts {
  create: number;
  update: number;
  delete: number;
  replace: number;
  forget: number;
  deleted: string[];
  replaced: string[];
}

export function countChanges(plan: PlanJson): PlanCounts {
  const counts: PlanCounts = { create: 0, update: 0, delete: 0, replace: 0, forget: 0, deleted: [], replaced: [] };
  for (const rc of plan.resource_changes ?? []) {
    const a = rc.change.actions;
    if (a.includes("delete") && a.includes("create")) {
      counts.replace++;
      counts.replaced.push(rc.address);
    } else if (a.includes("delete")) {
      counts.delete++;
      counts.deleted.push(rc.address);
    } else if (a.includes("create")) counts.create++;
    else if (a.includes("update")) counts.update++;
    else if (a.includes("forget")) counts.forget++;
  }
  return counts;
}

export const marker = (root: string): string => `<!-- infra-plan:${root} -->`;

export function renderSummary(root: string, plan: PlanJson, policy?: PolicyResult): string {
  const c = countChanges(plan);
  const lines = [
    marker(root),
    `### \`${root}\``,
    "",
    `| create | update | delete | replace | forget |`,
    `| ---: | ---: | ---: | ---: | ---: |`,
    `| ${c.create} | ${c.update} | ${c.delete} | ${c.replace} | ${c.forget} |`,
  ];
  if (c.replaced.length + c.deleted.length > 0) {
    lines.push("", "**Delete / replace targets**", "");
    for (const a of c.replaced) lines.push(`- replace: \`${a}\``);
    for (const a of c.deleted) lines.push(`- delete: \`${a}\``);
  }
  if (policy) {
    lines.push("", `**Plan policy (DT-INFRA-007): ${policy.allow ? "passed" : "FAILED"}**`);
    for (const m of policy.deny) lines.push(`- :x: ${m}`);
    for (const m of policy.warn) lines.push(`- :warning: ${m}`);
    for (const m of policy.exceptions_used) lines.push(`- :information_source: exception used: ${m}`);
  }
  return lines.join("\n");
}

/** Creates or updates the single comment of `root` on the PR. */
export async function upsertComment(token: string, repository: string, pr: number, root: string, body: string): Promise<void> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  const base = `https://api.github.com/repos/${repository}/issues`;
  const list = await fetch(`${base}/${pr}/comments?per_page=100`, { headers });
  if (!list.ok) throw new Error(`list comments: ${list.status}`);
  const existing = ((await list.json()) as { id: number; body?: string }[]).find((c) => c.body?.startsWith(marker(root)));
  const res = existing
    ? await fetch(`${base}/comments/${existing.id}`, { method: "PATCH", headers, body: JSON.stringify({ body }) })
    : await fetch(`${base}/${pr}/comments`, { method: "POST", headers, body: JSON.stringify({ body }) });
  if (!res.ok) throw new Error(`upsert comment: ${res.status} ${await res.text()}`);
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { post: { type: "string" } } });
  const [root, planPath, policyPath] = positionals;
  if (!root || !planPath) {
    console.error("usage: plan-summary.ts <root> <plan.json> [policy-result.json] [--post <pr>]");
    process.exit(2);
  }
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanJson;
  const policy = policyPath ? (JSON.parse(readFileSync(policyPath, "utf8")) as PolicyResult) : undefined;
  const body = renderSummary(root, plan, policy);
  console.log(body);
  if (values.post) {
    const token = process.env["GITHUB_TOKEN"];
    const repository = process.env["GITHUB_REPOSITORY"];
    if (!token || !repository) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required for --post");
    await upsertComment(token, repository, Number(values.post), root, body);
  }
}

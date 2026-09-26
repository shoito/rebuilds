// DT-INFRA-008: turn the daily `terraform plan -detailed-exitcode` results into
// GitHub Issues (REQ-INFRA-019).
// Usage: node src/drift-report.ts <results.json>
//   results.json: [{"root": "...", "exitCode": 0|1|2, "summary": "..."}]
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo)
import { readFileSync } from "node:fs";

export interface DriftResult {
  root: string;
  exitCode: number;
  summary: string;
}

export type DriftAction =
  | { kind: "create-drift-issue" }
  | { kind: "comment-drift-issue"; issue: number }
  | { kind: "report-error"; issue: number | undefined }
  | { kind: "close-drift-issue"; issue: number }
  | { kind: "none" };

/** Evaluates DT-INFRA-008 top-down. */
export function decide(exitCode: number, openDriftIssue: number | undefined, openErrorIssue: number | undefined): DriftAction {
  if (exitCode === 2 && openDriftIssue === undefined) return { kind: "create-drift-issue" };
  if (exitCode === 2) return { kind: "comment-drift-issue", issue: openDriftIssue! };
  if (exitCode === 1) return { kind: "report-error", issue: openErrorIssue };
  if (exitCode === 0 && openDriftIssue !== undefined) return { kind: "close-drift-issue", issue: openDriftIssue };
  return { kind: "none" };
}

export const driftTitle = (root: string): string => `drift: ${root}`;
export const errorTitle = (root: string): string => `drift-error: ${root}`;

/** Labels from docs/project-management.md sections 3 and 5 (Issue type: Task). */
export const LABELS = ["system:slack", "area:infra", "source:alert", "needs:ops"];

export interface IssueClient {
  findOpenIssue(title: string): Promise<number | undefined>;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
}

const fence = (s: string): string => `\`\`\`\n${s.slice(0, 60_000)}\n\`\`\``;

export async function report(result: DriftResult, client: IssueClient, today: string): Promise<DriftAction> {
  const drift = await client.findOpenIssue(driftTitle(result.root));
  const error = await client.findOpenIssue(errorTitle(result.root));
  const action = decide(result.exitCode, drift, error);
  switch (action.kind) {
    case "create-drift-issue":
      await client.createIssue(
        driftTitle(result.root),
        `Drift detected in \`${result.root}\` on ${today}.\n\nRevert the manual change or reflect it in code within 24 hours (ADR-0020).\n\n${fence(result.summary)}`,
        LABELS,
      );
      break;
    case "comment-drift-issue":
      await client.comment(action.issue, `Drift still present on ${today}.\n\n${fence(result.summary)}`);
      break;
    case "report-error":
      if (action.issue === undefined) {
        await client.createIssue(
          errorTitle(result.root),
          `\`terraform plan\` failed for \`${result.root}\` on ${today}.\n\n${fence(result.summary)}`,
          LABELS,
        );
      } else {
        await client.comment(action.issue, `Plan failed again on ${today}.\n\n${fence(result.summary)}`);
      }
      break;
    case "close-drift-issue":
      await client.comment(action.issue, `Resolved: no drift in \`${result.root}\` on ${today}.`);
      await client.close(action.issue);
      break;
    case "none":
      break;
  }
  return action;
}

export function githubClient(token: string, repository: string): IssueClient {
  const api = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await fetch(`https://api.github.com/repos/${repository}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? undefined : res.json();
  };
  return {
    async findOpenIssue(title) {
      const issues = (await api(`/issues?state=open&labels=area:infra&per_page=100`)) as { number: number; title: string; pull_request?: unknown }[];
      return issues.find((i) => i.title === title && !i.pull_request)?.number;
    },
    async createIssue(title, body, labels) {
      const created = (await api(`/issues`, { method: "POST", body: JSON.stringify({ title, body, labels, type: "Task" }) })) as { number: number };
      return created.number;
    },
    async comment(issue, body) {
      await api(`/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    },
    async close(issue) {
      await api(`/issues/${issue}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) });
    },
  };
}

if (import.meta.main) {
  const path = process.argv[2];
  const token = process.env["GITHUB_TOKEN"];
  const repository = process.env["GITHUB_REPOSITORY"];
  if (!path || !token || !repository) {
    console.error("usage: GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo drift-report.ts <results.json>");
    process.exit(2);
  }
  const results = JSON.parse(readFileSync(path, "utf8")) as DriftResult[];
  const client = githubClient(token, repository);
  const today = new Date().toISOString().slice(0, 10);
  for (const r of results) {
    const action = await report(r, client, today);
    console.log(`${r.root}: exit ${r.exitCode} -> ${action.kind}`);
  }
}

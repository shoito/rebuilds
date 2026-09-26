// REQ-DLV-012: weekly p90 of the PR CI duration (until ci-gate completes).
import type { GitHub } from "./github.ts";

export const TARGET_MINUTES = 15;
export const ISSUE_TITLE = "ci-slow";

export interface Job {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface Run {
  id: number;
  conclusion: string | null;
  run_started_at: string;
  jobs: Job[];
}

const minutes = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;

/** Nearest-rank percentile. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export interface DurationReport {
  runs: number;
  p90: number;
  exceeded: boolean;
  slowestJobs: { name: string; p90: number }[];
}

/** Cancelled runs (superseded by a newer push) are excluded from the measurement. */
export function analyze(runs: Run[]): DurationReport {
  const gate: number[] = [];
  const jobs = new Map<string, number[]>();
  for (const run of runs) {
    if (run.conclusion === "cancelled") continue;
    const g = run.jobs.find((j) => j.name === "ci-gate");
    if (!g?.completed_at) continue;
    gate.push(minutes(run.run_started_at, g.completed_at));
    for (const j of run.jobs) {
      if (j.name === "ci-gate" || !j.started_at || !j.completed_at) continue;
      jobs.set(j.name, [...(jobs.get(j.name) ?? []), minutes(j.started_at, j.completed_at)]);
    }
  }
  const p90 = percentile(gate, 90);
  const slowestJobs = [...jobs]
    .map(([name, d]) => ({ name, p90: percentile(d, 90) }))
    .sort((a, b) => b.p90 - a.p90 || a.name.localeCompare(b.name))
    .slice(0, 5);
  return { runs: gate.length, p90, exceeded: p90 > TARGET_MINUTES, slowestJobs };
}

export function issueBody(r: DurationReport): string {
  return [
    `The p90 of the PR CI duration (until \`ci-gate\` completes) over the last 7 days is ${r.p90.toFixed(1)} min (target: ${TARGET_MINUTES} min, ${r.runs} runs). See REQ-DLV-012.`,
    "",
    "Slowest jobs (p90):",
    "",
    "| Job | p90 (min) |",
    "| --- | --- |",
    ...r.slowestJobs.map((j) => `| ${j.name} | ${j.p90.toFixed(1)} |`),
  ].join("\n");
}

export async function fetchRuns(gh: GitHub, since: Date): Promise<Run[]> {
  const day = since.toISOString().slice(0, 10);
  const runs: Run[] = [];
  for (let page = 1; ; page++) {
    const res = await gh.get<{ workflow_runs: Omit<Run, "jobs">[] }>(
      `/repos/{repo}/actions/workflows/ci.yml/runs?event=pull_request&status=completed&created=${encodeURIComponent(`>=${day}`)}&per_page=100&page=${page}`,
    );
    for (const r of res.workflow_runs) {
      if (Date.parse(r.run_started_at) < since.getTime()) continue;
      const { jobs } = await gh.get<{ jobs: Job[] }>(`/repos/{repo}/actions/runs/${r.id}/jobs?per_page=100`);
      runs.push({ id: r.id, conclusion: r.conclusion, run_started_at: r.run_started_at, jobs });
    }
    if (res.workflow_runs.length < 100) return runs;
  }
}

export async function measure(gh: GitHub, now: Date): Promise<DurationReport> {
  const report = analyze(await fetchRuns(gh, new Date(now.getTime() - 7 * 86_400_000)));
  if (report.exceeded) await gh.ensureIssue(ISSUE_TITLE, issueBody(report), ["area:delivery", "source:alert", "needs:dev"]);
  return report;
}

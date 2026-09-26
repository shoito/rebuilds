import { describe, expect, it } from "vitest";
import { analyze, measure, percentile, type Run } from "../src/ci-duration.ts";
import { fakeGitHub } from "./fake-github.ts";

const T0 = Date.parse("2026-09-20T00:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** A run whose ci-gate completes after `gate` minutes; `jobs` are [name, minutes]. */
function run(id: number, gate: number, conclusion = "success", jobs: [string, number][] = []): Run {
  return {
    id,
    conclusion,
    run_started_at: at(0),
    jobs: [
      ...jobs.map(([name, m]) => ({ name, started_at: at(0), completed_at: at(m) })),
      { name: "ci-gate", started_at: at(gate - 0.5), completed_at: at(gate) },
    ],
  };
}

describe("REQ-DLV-012: CI duration", () => {
  it("REQ-DLV-012: p90 uses the nearest-rank method", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([18], 90)).toBe(18);
    expect(percentile([], 90)).toBe(0);
  });

  it("REQ-DLV-012: a p90 over 15 minutes is exceeded and lists the 5 slowest jobs", () => {
    const jobs: [string, number][] = [["slack-integration", 14], ["slack-test", 9], ["slack-static", 6], ["spec-checks", 2], ["changes", 1], ["tools-test", 3]];
    const runs = Array.from({ length: 10 }, (_, i) => run(i, 18, "success", jobs));
    const r = analyze(runs);
    expect(r).toMatchObject({ runs: 10, p90: 18, exceeded: true });
    expect(r.slowestJobs.map((j) => j.name)).toEqual(["slack-integration", "slack-test", "slack-static", "tools-test", "spec-checks"]);
  });

  it("REQ-DLV-012: runs cancelled by a newer push are excluded", () => {
    const r = analyze([run(1, 10), run(2, 40, "cancelled"), run(3, 12)]);
    expect(r).toMatchObject({ runs: 2, p90: 12, exceeded: false });
  });

  const routes = (issues: unknown[]) => ({
    "GET /repos/example-org/rebuilds/actions/workflows/ci.yml/runs": {
      workflow_runs: [{ id: 7, conclusion: "failure", run_started_at: at(0) }],
    },
    "GET /repos/example-org/rebuilds/actions/runs/7/jobs": { jobs: run(7, 18, "failure", [["slack-test", 17]]).jobs },
    "GET /repos/example-org/rebuilds/issues": issues,
    "POST /repos/example-org/rebuilds/issues": { number: 99 },
    "POST /repos/example-org/rebuilds/issues/12/comments": { id: 1 },
  });

  it("REQ-DLV-012: creates one ci-slow issue with the Dev queue labels", async () => {
    const { gh, calls } = fakeGitHub(routes([]));
    const r = await measure(gh, new Date(at(60)));
    expect(r.exceeded).toBe(true);
    const created = calls.filter((c) => c.method === "POST");
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toMatchObject({ title: "ci-slow", type: "Task", labels: ["area:delivery", "source:alert", "needs:dev"] });
    expect((created[0]!.body as { body: string }).body).toContain("| slack-test | 17.0 |");
  });

  it("REQ-DLV-012: comments on the open ci-slow issue instead of creating another", async () => {
    const { gh, calls } = fakeGitHub(routes([{ number: 12, title: "ci-slow" }]));
    await measure(gh, new Date(at(60)));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/repos/example-org/rebuilds/issues/12/comments"]);
  });

  it("REQ-DLV-012: retries without the issue type where issue types are unavailable", async () => {
    const r = routes([]);
    const { gh, calls } = fakeGitHub({
      ...r,
      "POST /repos/example-org/rebuilds/issues": (body: unknown) =>
        (body as { type?: string }).type ? new Response("type not allowed", { status: 422 }) : { number: 5 },
    });
    await measure(gh, new Date(at(60)));
    expect(calls.filter((c) => c.method === "POST").map((c) => (c.body as { type?: string }).type)).toEqual(["Task", undefined]);
  });
});

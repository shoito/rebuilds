// REQ-DLV-004 (DT-DLV-002): the single required check `ci-gate`.

export interface GateFacts {
  failure: boolean;
  cancelled: boolean;
  skipped: boolean;
}

/** DT-DLV-002, evaluated top to bottom. Non-target jobs are not part of the facts. */
export function evaluateGate(f: GateFacts): { row: number; pass: boolean } {
  if (f.failure) return { row: 1, pass: false };
  if (f.cancelled) return { row: 2, pass: false };
  if (f.skipped) return { row: 3, pass: false };
  return { row: 4, pass: true };
}

export type Needs = Record<string, { result: string; outputs?: Record<string, string> }>;

/** `needs` is `toJSON(needs)` of the ci-gate job. */
export function judge(needs: Needs): { pass: boolean; row: number; summary: string } {
  const jobs = Object.keys(needs).sort();
  let targets: string[] = jobs;
  if (needs.changes?.result === "success") {
    try {
      targets = JSON.parse(needs.changes.outputs?.targets ?? "") as string[];
    } catch {
      targets = jobs;
    }
  }
  // If `changes` failed, every job is a target (DT-DLV-002 note).
  const targeted = jobs.filter((j) => targets.includes(j));
  const by = (r: string) => targeted.filter((j) => needs[j]!.result === r);
  const facts = { failure: by("failure").length > 0, cancelled: by("cancelled").length > 0, skipped: by("skipped").length > 0 };
  const { row, pass } = evaluateGate(facts);
  const lines = [`ci-gate: ${pass ? "success" : "failure"} (DT-DLV-002 #${row})`];
  for (const j of jobs) lines.push(`- ${j}: ${needs[j]!.result}${targeted.includes(j) ? "" : " (not a target)"}`);
  if (!pass) {
    const bad = row === 1 ? by("failure") : row === 2 ? by("cancelled") : by("skipped");
    lines.push(`Failed checks: ${bad.join(", ")}${row === 3 ? " (target but did not run)" : ""}`);
  }
  return { pass, row, summary: lines.join("\n") };
}

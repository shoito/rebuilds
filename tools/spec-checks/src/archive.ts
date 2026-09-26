// REQ-DLV-009 (DT-DLV-005): optimistic lock when archiving a change.
import { normalize } from "./parse-spec.ts";
import { specsFromFiles, type FileMap, type Finding, type SpecFile } from "./repo.ts";

export interface ArchiveFacts {
  specsChanged: boolean;
  moved: boolean;
  /** Every moved change has `status: done`. */
  allDone: boolean;
  beforeMatches: boolean;
  reflected: boolean;
}

/** DT-DLV-005, evaluated top to bottom. */
export function evaluateArchive(f: ArchiveFacts): { row: number; outcome: "n/a" | "ok" | "fail" } {
  if (!f.specsChanged && !f.moved) return { row: 1, outcome: "n/a" };
  if (f.specsChanged && !f.moved) return { row: 2, outcome: "fail" };
  if (!f.allDone) return { row: 3, outcome: "fail" };
  if (!f.beforeMatches) return { row: 4, outcome: "fail" };
  if (!f.reflected) return { row: 5, outcome: "fail" };
  return { row: 6, outcome: "ok" };
}

/** Minimal line diff (LCS) for error messages. */
export function lineDiff(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      out.push(`  ${x[i++]}`);
      j++;
    } else if (j < y.length && (i === x.length || dp[i]![j + 1]! >= dp[i + 1]![j]!)) {
      out.push(`+ ${y[j++]}`);
    } else {
      out.push(`- ${x[i++]}`);
    }
  }
  return out.join("\n");
}

function canonicalBlocks(specs: SpecFile[]): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const s of specs) {
    if (s.kind !== "canonical") continue;
    for (const e of s.parsed.entries) blocks.set(e.id, normalize(e.body));
  }
  return blocks;
}

function sameMaps(a: FileMap, b: FileMap, filter: (path: string) => boolean): string[] {
  const paths = new Set([...a.keys(), ...b.keys()].filter(filter));
  return [...paths].filter((p) => a.get(p) !== b.get(p)).sort();
}

/**
 * `base` holds the files at the comparison base (PR base or merge queue base),
 * `head` the files after the PR. Only spec.md files are looked at.
 */
export function checkArchive(base: FileMap, head: FileMap): { row: number; findings: Finding[] } {
  const baseSpecs = specsFromFiles(base);
  const headSpecs = specsFromFiles(head);
  const changedCanonical = sameMaps(base, head, (p) => /^systems\/[^/]+\/docs\/specs\/.+\/spec\.md$/.test(p));
  const basePaths = new Set(baseSpecs.map((s) => s.path));
  const moved = headSpecs.filter((s) => s.kind === "archive" && !basePaths.has(s.path));

  const findings: Finding[] = [];
  const notDone = moved.filter((s) => s.parsed.frontmatter?.status !== "done");
  for (const s of notDone) {
    findings.push({ level: "error", path: s.path, line: 1, message: `archived change must have status: done (DT-DLV-005 #3)` });
  }

  const baseBlocks = canonicalBlocks(baseSpecs);
  const lockFindings: Finding[] = [];
  const expected = new Map(baseBlocks);
  for (const s of moved) {
    for (const e of s.parsed.entries) {
      if (e.section === "MODIFIED" || e.section === "REMOVED") {
        const current = baseBlocks.get(e.id);
        const before = normalize(e.before ?? "");
        if (current === undefined) {
          lockFindings.push({ level: "error", path: s.path, line: e.line, message: `${e.id}: not found in specs/ at the base commit (DT-DLV-005 #4)` });
        } else if (current !== before) {
          lockFindings.push({
            level: "error",
            path: s.path,
            line: e.line,
            message: `${e.id}: Before does not match specs/ at the base commit (DT-DLV-005 #4). Rewrite the delta against the latest spec.\n${lineDiff(before, current)}`,
          });
        }
      }
      if (e.section === "ADDED") expected.set(e.id, normalize(e.body));
      if (e.section === "MODIFIED") expected.set(e.id, normalize(e.after ?? ""));
      if (e.section === "REMOVED") expected.delete(e.id);
    }
  }

  const headBlocks = canonicalBlocks(headSpecs);
  const reflectFindings: Finding[] = [];
  for (const id of [...new Set([...expected.keys(), ...headBlocks.keys()])].sort()) {
    const want = expected.get(id);
    const got = headBlocks.get(id);
    if (want === got) continue;
    const message =
      got === undefined
        ? `${id}: missing from specs/ after the archive`
        : want === undefined
          ? `${id}: in specs/ but neither in the base nor added by an archived change`
          : `${id}: specs/ block differs from what the archived change(s) describe\n${lineDiff(want, got)}`;
    reflectFindings.push({ level: "error", path: "specs/", line: 0, message: `${message} (DT-DLV-005 #5)` });
  }

  const r = evaluateArchive({
    specsChanged: changedCanonical.length > 0,
    moved: moved.length > 0,
    allDone: notDone.length === 0,
    beforeMatches: lockFindings.length === 0,
    reflected: reflectFindings.length === 0,
  });
  if (r.row === 2) {
    for (const p of changedCanonical) {
      findings.push({ level: "error", path: p, line: 1, message: "specs/ may only change in an archive PR (DT-DLV-005 #2)" });
    }
  }
  if (r.row === 4) findings.push(...lockFindings);
  if (r.row === 5) findings.push(...reflectFindings);
  return { row: r.row, findings };
}

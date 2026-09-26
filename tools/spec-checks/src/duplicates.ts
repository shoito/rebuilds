// REQ-DLV-008: ID collisions (DT-DLV-004), ID prefixes and ADR numbers.
import type { Finding, SpecFile, TextFile } from "./repo.ts";

export interface ConflictCounts {
  /** Definitions in specs/. */
  S: number;
  /** ADDED definitions in unarchived changes. */
  A: number;
  /** MODIFIED / REMOVED references in unarchived changes. */
  M: number;
  /** Recorded as REMOVED in an archived change. */
  R: boolean;
}

export type ConflictResult = { row: number; outcome: "fail" | "warn" | "ok"; reason: string };

/** DT-DLV-004, evaluated top to bottom. */
export function evaluateConflict(c: ConflictCounts): ConflictResult {
  if (c.S >= 2) return { row: 1, outcome: "fail", reason: "defined more than once in specs/" };
  if (c.A >= 2) return { row: 2, outcome: "fail", reason: "added by more than one change" };
  if (c.S === 1 && c.A === 1) return { row: 3, outcome: "fail", reason: "reuses an existing ID" };
  if (c.A === 1 && c.R) return { row: 4, outcome: "fail", reason: "reuses a removed (retired) ID" };
  if (c.S === 0 && c.M >= 1) return { row: 5, outcome: "fail", reason: "MODIFIED / REMOVED an ID that is not in specs/" };
  if (c.S === 1 && c.A === 0 && c.M >= 2) {
    return { row: 6, outcome: "warn", reason: "modified by more than one change; PM decides which goes first" };
  }
  return { row: 7, outcome: "ok", reason: "" };
}

interface Location {
  path: string;
  line: number;
}

export function checkConflicts(specs: SpecFile[]): Finding[] {
  const counts = new Map<string, ConflictCounts & { at: Location[] }>();
  const get = (id: string) => {
    let c = counts.get(id);
    if (!c) counts.set(id, (c = { S: 0, A: 0, M: 0, R: false, at: [] }));
    return c;
  };
  for (const spec of specs) {
    for (const e of spec.parsed.entries) {
      const c = get(e.id);
      if (spec.kind === "archive") {
        if (e.section === "REMOVED") c.R = true;
        continue;
      }
      if (spec.kind === "canonical") c.S++;
      else if (e.section === "ADDED") c.A++;
      else c.M++;
      c.at.push({ path: spec.path, line: e.line });
    }
  }
  const findings: Finding[] = [];
  for (const [id, c] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const r = evaluateConflict(c);
    if (r.outcome === "ok") continue;
    const at = [...c.at].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    const where = at.map((l) => `${l.path}:${l.line}`).join(", ");
    findings.push({
      level: r.outcome === "fail" ? "error" : "warning",
      path: at[0]?.path ?? "",
      line: at[0]?.line ?? 0,
      message: `${id}: ${r.reason} (DT-DLV-004 #${r.row}); defined at ${where}`,
    });
  }
  return findings;
}

/** The ID's capability part must match the prefix of the spec's `capability`. */
export function checkPrefixes(specs: SpecFile[], prefixTables: Map<string, Map<string, string>>): Finding[] {
  const findings: Finding[] = [];
  for (const spec of specs) {
    if (spec.kind === "archive" || spec.parsed.entries.length === 0) continue;
    const capability = spec.parsed.frontmatter?.capability;
    const prefix = capability ? prefixTables.get(spec.system)?.get(capability) : undefined;
    if (!prefix) {
      findings.push({
        level: "error",
        path: spec.path,
        line: 1,
        message: `capability "${capability ?? ""}" has no ID prefix in systems/${spec.system}/docs/specs/README.md`,
      });
      continue;
    }
    for (const e of spec.parsed.entries) {
      const cap = e.id.split("-")[1];
      if (cap !== prefix) {
        findings.push({
          level: "error",
          path: spec.path,
          line: e.line,
          message: `${e.id}: prefix ${cap} does not match capability "${capability}" (expected ${prefix})`,
        });
      }
    }
  }
  return findings;
}

/** ADR files in one decisions/ directory: unique numbers, heading matches file name. */
export function checkAdrNumbers(adrs: TextFile[]): Finding[] {
  const findings: Finding[] = [];
  const byNumber = new Map<string, string[]>();
  for (const adr of adrs) {
    const name = adr.path.split("/").pop()!;
    const num = /^(\d{4})-/.exec(name)?.[1];
    if (!num) continue;
    byNumber.set(num, [...(byNumber.get(num) ?? []), adr.path]);
    const heading = /^# ADR-(\d{4}):/m.exec(adr.text)?.[1];
    if (heading !== num) {
      findings.push({
        level: "error",
        path: adr.path,
        line: 1,
        message: heading
          ? `heading ADR-${heading} does not match file number ${num}`
          : `missing "# ADR-${num}: ..." heading`,
      });
    }
  }
  for (const [num, paths] of [...byNumber].sort(([a], [b]) => a.localeCompare(b))) {
    if (paths.length > 1) {
      const sorted = [...paths].sort();
      findings.push({
        level: "error",
        path: sorted[0]!,
        line: 1,
        message: `ADR number ${num} is used by more than one file: ${sorted.join(", ")}`,
      });
    }
  }
  return findings;
}

// REQ-DLV-006 (DT-DLV-003): every defined ID is referenced from a test file.
// REQ-DLV-007: test files and plan.md only reference defined IDs.
import { ID_PATTERN } from "./parse-spec.ts";
import type { Finding, SpecFile, TextFile } from "./repo.ts";

export type TraceOutcome = "n/a" | "ok" | "fail" | "warn";

export interface TraceFacts {
  /** Where the ID is defined; "REMOVED" means a change's REMOVED section. */
  location: "REMOVED" | "specs" | "change";
  /** frontmatter status of the change (undefined when there is none). */
  status?: string;
  referenced: boolean;
}

/** DT-DLV-003, evaluated top to bottom. */
export function evaluateTrace(f: TraceFacts): { row: number; outcome: TraceOutcome } {
  if (f.location === "REMOVED") return { row: 1, outcome: "n/a" };
  if (f.location === "specs") return f.referenced ? { row: 2, outcome: "ok" } : { row: 3, outcome: "fail" };
  switch (f.status) {
    case "draft":
    case "approved":
      return { row: 4, outcome: "n/a" };
    case "in-progress":
      return f.referenced ? { row: 5, outcome: "ok" } : { row: 6, outcome: "warn" };
    case "done":
      return f.referenced ? { row: 7, outcome: "ok" } : { row: 8, outcome: "fail" };
    default:
      return { row: 9, outcome: "fail" };
  }
}

const TOKEN = /(?<![\w-])(?:REQ|PROP|DT)-[A-Za-z0-9]+-[A-Za-z0-9]+(?!\w)/g;

export interface Reference {
  id: string;
  path: string;
  line: number;
}

/** ID-like tokens in a file; word boundaries keep REQ-MSG-001 from matching REQ-MSG-0010. */
export function findReferences(file: TextFile): Reference[] {
  const refs: Reference[] = [];
  file.text.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(TOKEN)) refs.push({ id: m[0], path: file.path, line: i + 1 });
  });
  return refs;
}

export interface TraceReport {
  findings: Finding[];
  /** DT-DLV-003 #4: unreferenced IDs of draft / approved changes (summary only). */
  pending: string[];
  /** Outcome per defined ID, for reporting and tests. */
  outcomes: Map<string, TraceOutcome>;
}

const RANK: Record<TraceOutcome, number> = { "n/a": 0, ok: 1, warn: 2, fail: 3 };

export function checkTrace(specs: SpecFile[], testFiles: TextFile[]): TraceReport {
  const referenced = new Set(testFiles.flatMap(findReferences).map((r) => r.id));
  const byId = new Map<string, { spec: SpecFile; line: number; section: string }[]>();
  for (const spec of specs) {
    if (spec.kind === "archive") continue;
    for (const e of spec.parsed.entries) {
      byId.set(e.id, [...(byId.get(e.id) ?? []), { spec, line: e.line, section: e.section }]);
    }
  }

  const findings: Finding[] = [];
  const pending: string[] = [];
  const outcomes = new Map<string, TraceOutcome>();
  for (const [id, defs] of [...byId].sort(([a], [b]) => a.localeCompare(b))) {
    const isRef = referenced.has(id);
    // Rows 1-3 are about the ID as a whole; rows 4-9 apply to each change that defines it.
    let facts: TraceFacts[];
    if (defs.some((d) => d.spec.kind === "change" && d.section === "REMOVED")) {
      facts = [{ location: "REMOVED", referenced: isRef }];
    } else if (defs.some((d) => d.spec.kind === "canonical")) {
      facts = [{ location: "specs", referenced: isRef }];
    } else {
      facts = defs.map((d) => ({ location: "change", status: d.spec.parsed.frontmatter?.status, referenced: isRef }));
    }
    let worst: { row: number; outcome: TraceOutcome; def: (typeof defs)[number] } | undefined;
    facts.forEach((f, i) => {
      const r = evaluateTrace(f);
      if (!worst || RANK[r.outcome] > RANK[worst.outcome]) worst = { ...r, def: defs[i] ?? defs[0]! };
    });
    const w = worst!;
    outcomes.set(id, w.outcome);
    if (w.row === 4 && !isRef) pending.push(id);
    if (w.outcome === "fail" || w.outcome === "warn") {
      const status = w.def.spec.parsed.frontmatter?.status;
      const why =
        w.row === 9
          ? `change has an unknown or missing status "${status ?? ""}"`
          : "is not referenced from any test file";
      findings.push({
        level: w.outcome === "fail" ? "error" : "warning",
        path: w.def.spec.path,
        line: w.def.line,
        message: `${id}: ${why} (DT-DLV-003 #${w.row})`,
      });
    }
  }
  return { findings, pending, outcomes };
}

/** REQ-DLV-007: references must be well-formed (tests) and defined (tests and plan.md). */
export function checkReferences(specs: SpecFile[], testFiles: TextFile[], planFiles: TextFile[]): Finding[] {
  const defined = new Set<string>();
  const removed = new Set<string>();
  for (const spec of specs) {
    for (const e of spec.parsed.entries) {
      if (spec.kind !== "archive") defined.add(e.id);
      else if (e.section === "REMOVED") removed.add(e.id);
    }
  }
  const findings: Finding[] = [];
  const check = (files: TextFile[], isTest: boolean) => {
    for (const ref of files.flatMap(findReferences)) {
      let message: string | undefined;
      if (!ID_PATTERN.test(ref.id)) {
        // plan.md uses placeholders such as "DT-WEB-00N #row"; only test names must be exact.
        if (isTest) message = `${ref.id}: malformed ID (expected <REQ|PROP|DT>-<CAP>-NNN with 3 digits)`;
      } else if (defined.has(ref.id)) {
        continue;
      } else if (removed.has(ref.id)) {
        message = `${ref.id}: reference to a removed ID (recorded as REMOVED in an archived change)`;
      } else {
        message = `${ref.id}: reference to an ID that is not defined anywhere`;
      }
      if (message) findings.push({ level: "error", path: ref.path, line: ref.line, message });
    }
  };
  check(testFiles, true);
  check(planFiles, false);
  return findings;
}

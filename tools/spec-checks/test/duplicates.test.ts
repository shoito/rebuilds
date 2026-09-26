import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkAdrNumbers, checkConflicts, checkPrefixes, evaluateConflict, type ConflictCounts } from "../src/duplicates.ts";
import { specsFromFiles } from "../src/repo.ts";
import { PREFIXES, specSetArb, toFiles, type MSpec } from "./arbitraries/specs.ts";
import { combinations, firstRow, ids, loadTable, outcomeOf } from "./support.ts";

const table = loadTable("DT-DLV-004");
const COLS = { S: 1, A: 2, M: 3, R: 4 } as const;

/** Interprets the condition cells of DT-DLV-004 ("2 以上", "1", "0", "あり"). */
function cellMatches(cell: string, column: number, c: ConflictCounts): boolean {
  if (column === COLS.R) return cell === "あり" ? c.R : !c.R;
  const value = column === COLS.S ? c.S : column === COLS.A ? c.A : c.M;
  const m = /^(\d+)( 以上)?$/.exec(cell);
  if (!m) throw new Error(`unknown cell ${cell}`);
  return m[2] ? value >= Number(m[1]) : value === Number(m[1]);
}

/** Reference implementation: the table itself, read from spec.md. */
function expectedRow(c: ConflictCounts): string[] {
  return firstRow(table, [COLS.S, COLS.A, COLS.M, COLS.R], c, cellMatches)!;
}

const ALL = combinations({ S: [0, 1, 2, 3], A: [0, 1, 2, 3], M: [0, 1, 2, 3], R: [false, true] });

describe("DT-DLV-004: ID definition conflicts", () => {
  it.each(table.rows.map((r) => [r[0]!, r]))("DT-DLV-004 #%s", (row, cells) => {
    const cases = ALL.filter((c) => expectedRow(c)[0] === row);
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const r = evaluateConflict(c);
      expect(r.row, JSON.stringify(c)).toBe(Number(row));
      expect(r.outcome).toBe(outcomeOf(cells.at(-1)!));
    }
  });
});

const spec = (path: string, body: string) => [path, ids(body)] as [string, string];

describe("REQ-DLV-008: ID and ADR number collisions", () => {
  it("REQ-DLV-008: reusing an existing ID fails and shows the existing definition", () => {
    const files = new Map([
      spec("systems/slack/docs/specs/messaging/spec.md", "---\ncapability: messaging\n---\n## Requirements\n\n### REQ~MSG~001: a\n"),
      spec("systems/slack/docs/changes/260101-x/spec.md", "---\ncapability: messaging\nstatus: draft\n---\n## ADDED Requirements\n\n### REQ~MSG~001: b\n"),
    ]);
    const [f, ...rest] = checkConflicts(specsFromFiles(files));
    expect(rest).toEqual([]);
    expect(f!.level).toBe("error");
    expect(f!.message).toContain("DT-DLV-004 #3");
    expect(f!.message).toContain("systems/slack/docs/specs/messaging/spec.md:6");
  });

  it("REQ-DLV-008: the same ID twice in one change counts as two definitions (Q7)", () => {
    const files = new Map([
      spec("systems/slack/docs/changes/260101-x/spec.md", "## ADDED Requirements\n\n### REQ~MSG~001: a\n\n### REQ~MSG~001: b\n"),
    ]);
    expect(checkConflicts(specsFromFiles(files)).map((f) => f.message)).toEqual([expect.stringContaining("DT-DLV-004 #2")]);
  });

  it("REQ-DLV-005: two PRs adding the same ID pass alone but fail once combined in the merge queue", () => {
    const a = spec("systems/slack/docs/changes/260101-a/spec.md", "---\ncapability: messaging\nstatus: draft\n---\n## ADDED Requirements\n\n### REQ~MSG~007: a\n");
    const b = spec("systems/slack/docs/changes/260101-b/spec.md", "---\ncapability: messaging\nstatus: draft\n---\n## ADDED Requirements\n\n### REQ~MSG~007: b\n");
    expect(checkConflicts(specsFromFiles(new Map([a])))).toEqual([]);
    expect(checkConflicts(specsFromFiles(new Map([b])))).toEqual([]);
    expect(checkConflicts(specsFromFiles(new Map([a, b])))[0]!.message).toContain("DT-DLV-004 #2");
  });

  it("REQ-DLV-008: an ID prefix that does not match the capability fails", () => {
    const files = new Map([
      spec("systems/slack/docs/changes/260101-x/spec.md", "---\ncapability: channels\nstatus: draft\n---\n## ADDED Requirements\n\n### REQ~DLV~020: a\n"),
    ]);
    const findings = checkPrefixes(specsFromFiles(files), PREFIXES);
    expect(findings).toEqual([expect.objectContaining({ level: "error", line: 7, message: expect.stringContaining("expected CHN") })]);
  });

  it("REQ-DLV-008: an unknown capability fails", () => {
    const files = new Map([spec("systems/slack/docs/changes/260101-x/spec.md", "---\ncapability: nope\n---\n### REQ~MSG~001: a\n")]);
    expect(checkPrefixes(specsFromFiles(files), PREFIXES)[0]!.message).toContain("no ID prefix");
  });

  it("REQ-DLV-008: two ADR files with the same number fail", () => {
    const adrs = [
      { path: "d/0034-a.md", text: "# ADR-0034: a" },
      { path: "d/0034-b.md", text: "# ADR-0034: b" },
    ];
    expect(checkAdrNumbers(adrs).map((f) => f.message)).toEqual([expect.stringContaining("d/0034-a.md, d/0034-b.md")]);
  });

  it("REQ-DLV-008: an ADR heading must match the file number", () => {
    expect(checkAdrNumbers([{ path: "d/0035-a.md", text: "---\n---\n# ADR-0036: a" }])[0]!.message).toContain("ADR-0036");
    expect(checkAdrNumbers([{ path: "d/0035-a.md", text: "# no heading" }])[0]!.message).toContain("missing");
    expect(checkAdrNumbers([{ path: "d/0035-a.md", text: "# ADR-0035: ok" }])).toEqual([]);
  });
});

/** Counts per ID straight from the generated model (not from the parser). */
function modelCounts(specs: MSpec[]): Map<string, ConflictCounts> {
  const counts = new Map<string, ConflictCounts>();
  for (const s of specs) {
    for (const e of s.entries) {
      const c = counts.get(e.id) ?? { S: 0, A: 0, M: 0, R: false };
      if (s.kind === "archive") c.R ||= e.section === "REMOVED";
      else if (s.kind === "canonical") c.S++;
      else if (e.section === "ADDED") c.A++;
      else c.M++;
      counts.set(e.id, c);
    }
  }
  return counts;
}

const errorIds = (findings: { level: string; message: string }[]) =>
  new Set(findings.filter((f) => f.level === "error").map((f) => f.message.split(":")[0]!));

describe("PROP-DLV-003", () => {
  it("PROP-DLV-003: reports exactly the IDs of DT-DLV-004 rows 1-5, regardless of file order", () => {
    fc.assert(
      fc.property(specSetArb, fc.array(fc.nat()), (specs, seeds) => {
        const expected = new Set(
          [...modelCounts(specs)].filter(([, c]) => Number(expectedRow(c)[0]) <= 5).map(([id]) => id),
        );
        const parsed = specsFromFiles(toFiles(specs));
        const findings = checkConflicts(parsed);
        expect(errorIds(findings)).toEqual(expected);

        const shuffled = [...parsed];
        if (shuffled.length > 0) seeds.forEach((s, i) => {
          const j = s % shuffled.length;
          const k = i % shuffled.length;
          [shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!];
        });
        expect(checkConflicts(shuffled)).toEqual(findings);
      }),
      { numRuns: 500 },
    );
  });
});

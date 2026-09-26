import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { specsFromFiles } from "../src/repo.ts";
import { checkReferences, checkTrace, evaluateTrace, findReferences, type TraceFacts } from "../src/trace.ts";
import { idArb, specSetArb, toFiles, type MSpec } from "./arbitraries/specs.ts";
import { combinations, firstRow, ids, loadTable, outcomeOf } from "./support.ts";

const table = loadTable("DT-DLV-003");
const KNOWN = ["draft", "approved", "in-progress", "done"];

/** Interprets the condition cells of DT-DLV-003. */
function cellMatches(cell: string, column: number, f: TraceFacts): boolean {
  if (column === 1) {
    if (cell.includes("REMOVED")) return f.location === "REMOVED";
    if (cell.includes("specs/")) return f.location === "specs";
    if (cell.includes("ADDED")) return f.location === "change";
  }
  if (column === 2) {
    if (cell.startsWith("上記以外")) return !KNOWN.includes(f.status ?? "");
    const listed = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    return listed.includes(f.status);
  }
  if (column === 3) return cell === "あり" ? f.referenced : !f.referenced;
  throw new Error(`unknown cell ${cell} in column ${column}`);
}

const expectedRow = (f: TraceFacts) => firstRow(table, [1, 2, 3], f, cellMatches)!;

describe("DT-DLV-003: traceability result", () => {
  const all = combinations({
    location: ["REMOVED", "specs", "change"] as const,
    status: [...KNOWN, "bogus", undefined],
    referenced: [true, false],
  });
  it.each(table.rows.map((r) => [r[0]!, r]))("DT-DLV-003 #%s", (row, cells) => {
    const cases = all.filter((f) => expectedRow(f)[0] === row);
    expect(cases.length).toBeGreaterThan(0);
    for (const f of cases) {
      expect(evaluateTrace(f), JSON.stringify(f)).toEqual({ row: Number(row), outcome: outcomeOf(cells.at(-1)!) });
    }
  });
});

const CANON = ids("---\ncapability: messaging\n---\n## Requirements\n\n### REQ~MSG~004: history\n");
const change = (status: string | null, id = "REQ~MSG~005") =>
  ids(`${status === null ? "" : `---\ncapability: messaging\nstatus: ${status}\n---\n`}## ADDED Requirements\n\n### ${id}: x\n`);
const test = (text: string) => ({ path: "systems/slack/apps/api/src/a.test.ts", text: ids(text) });

describe("REQ-DLV-006: traceability", () => {
  it("REQ-DLV-006: an unreferenced ID in specs/ fails and shows the ID and file", () => {
    const specs = specsFromFiles(new Map([["systems/slack/docs/specs/messaging/spec.md", CANON]]));
    const r = checkTrace(specs, [test("it('something else')")]);
    expect(r.findings).toEqual([
      { level: "error", path: "systems/slack/docs/specs/messaging/spec.md", line: 6, message: expect.stringContaining(ids("REQ~MSG~004")) },
    ]);
  });

  it("REQ-DLV-006: a draft change passes and lists its unreferenced IDs", () => {
    const specs = specsFromFiles(new Map([["systems/slack/docs/changes/260101-x/spec.md", change("draft", "REQ~DLV~001")]]));
    const r = checkTrace(specs, []);
    expect(r.findings).toEqual([]);
    expect(r.pending).toEqual([ids("REQ~DLV~001")]);
  });

  it("REQ-DLV-006: an in-progress change passes with a warning", () => {
    const specs = specsFromFiles(new Map([["systems/slack/docs/changes/260101-x/spec.md", change("in-progress")]]));
    expect(checkTrace(specs, []).findings.map((f) => f.level)).toEqual(["warning"]);
  });

  it("REQ-DLV-006: a change without frontmatter fails (Q6)", () => {
    const specs = specsFromFiles(new Map([["systems/slack/docs/changes/260101-x/spec.md", change(null)]]));
    expect(checkTrace(specs, [test("REQ~MSG~005")]).findings[0]!.message).toContain("DT-DLV-003 #9");
  });

  it("REQ-DLV-006: references use word boundaries (Q2)", () => {
    const specs = specsFromFiles(new Map([["systems/slack/docs/specs/messaging/spec.md", CANON]]));
    expect(checkTrace(specs, [test("it('REQ~MSG~0040')")]).outcomes.get(ids("REQ~MSG~004"))).toBe("fail");
    expect(checkTrace(specs, [test("it('xREQ~MSG~004')")]).outcomes.get(ids("REQ~MSG~004"))).toBe("fail");
    expect(checkTrace(specs, [test("it('REQ~MSG~004: ok')")]).outcomes.get(ids("REQ~MSG~004"))).toBe("ok");
    expect(checkTrace(specs, [test("it('DT~MSG~001 #3 and REQ~MSG~004')")]).outcomes.get(ids("REQ~MSG~004"))).toBe("ok");
  });
});

describe("REQ-DLV-007: references to undefined IDs", () => {
  const specs = specsFromFiles(
    new Map([
      ["systems/slack/docs/specs/messaging/spec.md", CANON],
      ["systems/slack/docs/changes/archive/260101-old/spec.md", ids("## REMOVED Requirements\n\n### REQ~MSG~003: x\n\n#### Before\n\nold\n")],
    ]),
  );

  it("REQ-DLV-007: a malformed ID in a test name fails with file, line and the reason", () => {
    const findings = checkReferences(specs, [test("\nit('REQ~MSG~02: typo')")], []);
    expect(findings).toEqual([
      { level: "error", path: "systems/slack/apps/api/src/a.test.ts", line: 2, message: expect.stringContaining("3 digits") },
    ]);
  });

  it("REQ-DLV-007: an ID in plan.md that is defined nowhere fails", () => {
    const plan = { path: "systems/slack/docs/changes/260101-x/plan.md", text: ids("| x | REQ~MSG~099 | unit |\n| y | REQ~MSG~004 | unit |") };
    expect(checkReferences(specs, [], [plan]).map((f) => f.message)).toEqual([expect.stringContaining(ids("REQ~MSG~099"))]);
  });

  it("REQ-DLV-007: plan.md placeholders such as DT~WEB~00N are not IDs", () => {
    const plan = { path: "systems/slack/docs/changes/260101-x/plan.md", text: ids("test names include `DT~WEB~00N #row`") };
    expect(checkReferences(specs, [], [plan])).toEqual([]);
  });

  it("REQ-DLV-007: a test that references a removed ID fails as a reference to a removed ID", () => {
    expect(checkReferences(specs, [test("it('REQ~MSG~003')")], [])[0]!.message).toContain("removed ID");
  });
});

/** Test files that reference IDs exactly, as part of a longer number, or glued to a word. */
const testFilesArb = fc.array(
  fc.array(
    fc.tuple(
      fc.oneof(idArb("MSG"), idArb("CHN")),
      fc.constantFrom(
        (id: string) => `it("${id}: does something", () => {});`,
        (id: string) => `// covers ${id}`,
        (id: string) => `const s = "${id}0";`,
        (id: string) => `const t = "x${id}";`,
      ),
    ),
    { maxLength: 12 },
  ),
  { maxLength: 3 },
);

/** Reference: aggregate the facts per ID from the model and evaluate the table from spec.md. */
function expectedTrace(specs: MSpec[], referenced: Set<string>): Map<string, "fail" | "warn"> {
  const defs = new Map<string, { kind: string; section: string; status: string | null }[]>();
  for (const s of specs) {
    if (s.kind === "archive") continue;
    for (const e of s.entries) defs.set(e.id, [...(defs.get(e.id) ?? []), { kind: s.kind, section: e.section, status: s.status }]);
  }
  const result = new Map<string, "fail" | "warn">();
  for (const [id, ds] of defs) {
    const isRef = referenced.has(id);
    let facts: TraceFacts[];
    if (ds.some((d) => d.kind === "change" && d.section === "REMOVED")) facts = [{ location: "REMOVED", referenced: isRef }];
    else if (ds.some((d) => d.kind === "canonical")) facts = [{ location: "specs", referenced: isRef }];
    else facts = ds.map((d) => ({ location: "change", status: d.status ?? undefined, referenced: isRef }));
    const outcomes = facts.map((f) => outcomeOf(expectedRow(f).at(-1)!));
    if (outcomes.includes("fail")) result.set(id, "fail");
    else if (outcomes.includes("warn")) result.set(id, "warn");
  }
  return result;
}

describe("PROP-DLV-002", () => {
  it("PROP-DLV-002: reports exactly the IDs that DT-DLV-003 marks as fail or warning", () => {
    fc.assert(
      fc.property(specSetArb, testFilesArb, (specs, files) => {
        const tests = files.map((lines, i) => ({ path: `t${i}.test.ts`, text: lines.map(([id, f]) => f(id)).join("\n") }));
        const referenced = new Set(files.flat().filter(([, f]) => f("X").startsWith("it(") || f("X").startsWith("//")).map(([id]) => id));
        const report = checkTrace(specsFromFiles(toFiles(specs)), tests);
        const actual = new Map(
          report.findings.map((f) => [f.message.split(":")[0]!, f.level === "error" ? "fail" : "warn"] as const),
        );
        expect(actual).toEqual(expectedTrace(specs, referenced));
      }),
      { numRuns: 500 },
    );
  });

  it("PROP-DLV-002: findReferences never treats a longer number as the shorter ID", () => {
    fc.assert(
      fc.property(idArb("MSG"), fc.integer({ min: 0, max: 9 }), (id, d) => {
        expect(findReferences({ path: "a", text: `${id}${d}` }).map((r) => r.id)).not.toContain(id);
      }),
    );
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkArchive, evaluateArchive, type ArchiveFacts } from "../src/archive.ts";
import { readSpecFiles, readSpecFilesAt, type FileMap } from "../src/repo.ts";
import { bodyArb } from "./arbitraries/specs.ts";
import { combinations, firstRow, ids, loadTable, outcomeOf } from "./support.ts";

const table = loadTable("DT-DLV-005");

function cellMatches(cell: string, column: number, f: ArchiveFacts): boolean {
  const yes = cell.startsWith("あり") || cell.startsWith("はい");
  switch (column) {
    case 1:
      return yes === f.specsChanged;
    case 2:
      return yes === f.moved;
    case 3:
      return cell.includes("以外") ? !f.allDone : f.allDone;
    case 4:
      return yes === f.beforeMatches;
    case 5:
      return yes === f.reflected;
  }
  throw new Error(`unknown column ${column}`);
}

describe("DT-DLV-005: archive check", () => {
  const all = combinations({
    specsChanged: [false, true],
    moved: [false, true],
    allDone: [false, true],
    beforeMatches: [false, true],
    reflected: [false, true],
  });
  it.each(table.rows.map((r) => [r[0]!, r]))("DT-DLV-005 #%s", (row, cells) => {
    const cases = all.filter((f) => firstRow(table, [1, 2, 3, 4, 5], f, cellMatches)![0] === row);
    expect(cases.length).toBeGreaterThan(0);
    for (const f of cases) {
      expect(evaluateArchive(f), JSON.stringify(f)).toEqual({ row: Number(row), outcome: outcomeOf(cells.at(-1)!) });
    }
  });
});

const CANON_PATH = "systems/slack/docs/specs/messaging/spec.md";
const canon = (req4: string) =>
  ids(`---\ncapability: messaging\n---\n\n# Spec: messaging\n\n## Requirements\n\n### REQ~MSG~001: post\n\nPost text.\n\n### REQ~MSG~004: history\n${req4}\n`);
const modify = (status: string, before: string, after: string) =>
  ids(`---\ncapability: messaging\nstatus: ${status}\n---\n\n## MODIFIED Requirements\n\n### REQ~MSG~004: history\n\n#### Before\n${before}\n#### After\n${after}\n`);

const V1 = "\nReturns 50 messages.\n\n#### Scenario: s\n\n- Then ok\n";
const V2 = "\nReturns 100 messages.\n";
const V3 = "\nReturns 200 messages.\n";

describe("REQ-DLV-009: optimistic lock", () => {
  it("REQ-DLV-009: fails when an earlier change already rewrote the requirement, and shows the diff", () => {
    // X was archived first: specs/ now has X's After (V2). Y still has Before = V1.
    const base: FileMap = new Map([
      [CANON_PATH, canon(V2)],
      ["systems/slack/docs/changes/260101-y/spec.md", modify("done", V1, V3)],
    ]);
    const head: FileMap = new Map([
      [CANON_PATH, canon(V3)],
      ["systems/slack/docs/changes/archive/260101-y/spec.md", modify("done", V1, V3)],
    ]);
    const r = checkArchive(base, head);
    expect(r.row).toBe(4);
    expect(r.findings[0]!.message).toContain("- Returns 50 messages.");
    expect(r.findings[0]!.message).toContain("+ Returns 100 messages.");
  });

  it("REQ-DLV-009: passes for a correct archive, comparing Before with the base (Q5)", () => {
    const base: FileMap = new Map([
      [CANON_PATH, canon(V1)],
      ["systems/slack/docs/changes/260101-z/spec.md", modify("done", `${V1}  \r\n`, V2)],
    ]);
    const head: FileMap = new Map([
      [CANON_PATH, canon(V2)],
      ["systems/slack/docs/changes/archive/260101-z/spec.md", modify("done", `${V1}  \r\n`, V2)],
    ]);
    expect(checkArchive(base, head)).toEqual({ row: 6, findings: [] });
  });

  it("REQ-DLV-009: editing specs/ without an archive fails", () => {
    const base: FileMap = new Map([[CANON_PATH, canon(V1)]]);
    const head: FileMap = new Map([[CANON_PATH, canon(V2)]]);
    expect(checkArchive(base, head).row).toBe(2);
  });

  it("REQ-DLV-009: archiving a change that is not done fails", () => {
    const base: FileMap = new Map([[CANON_PATH, canon(V1)]]);
    const head: FileMap = new Map([
      [CANON_PATH, canon(V2)],
      ["systems/slack/docs/changes/archive/260101-z/spec.md", modify("in-progress", V1, V2)],
    ]);
    expect(checkArchive(base, head).row).toBe(3);
  });

  it("REQ-DLV-009: a wrong reflection or an unrelated edit in specs/ fails", () => {
    const moved = modify("done", V1, V2);
    const base: FileMap = new Map([[CANON_PATH, canon(V1)]]);
    const wrongAfter: FileMap = new Map([[CANON_PATH, canon(V3)], ["systems/slack/docs/changes/archive/260101-z/spec.md", moved]]);
    expect(checkArchive(base, wrongAfter).row).toBe(5);
    const unrelated: FileMap = new Map([
      [CANON_PATH, canon(V2).replace("Post text.", "Post text!")],
      ["systems/slack/docs/changes/archive/260101-z/spec.md", moved],
    ]);
    const r = checkArchive(base, unrelated);
    expect(r.row).toBe(5);
    expect(r.findings[0]!.message).toContain(ids("REQ~MSG~001"));
  });

  it("REQ-DLV-009: ADDED and REMOVED must be reflected in specs/", () => {
    const delta = ids(
      "---\ncapability: messaging\nstatus: done\n---\n## ADDED Requirements\n\n### REQ~MSG~010: new\n\nNew.\n\n## REMOVED Requirements\n\n### REQ~MSG~001: post\n\n- 理由：x\n\n#### Before\n\nPost text.\n",
    );
    const base: FileMap = new Map([[CANON_PATH, canon(V1)]]);
    const good = ids(`---\ncapability: messaging\n---\n\n## Requirements\n\n### REQ~MSG~004: history\n${V1}\n### REQ~MSG~010: new\n\nNew.\n`);
    const archived = "systems/slack/docs/changes/archive/260101-z/spec.md";
    expect(checkArchive(base, new Map([[CANON_PATH, good], [archived, delta]])).row).toBe(6);
    expect(checkArchive(base, new Map([[CANON_PATH, canon(V1)], [archived, delta]])).row).toBe(5);
  });

  it("REQ-DLV-009: reads the base from git and the PR state from the working tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "archive-"));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), text);
      };
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, encoding: "utf8" });
      git("init", "-q");
      write(CANON_PATH, canon(V2));
      write("systems/slack/docs/changes/260101-y/spec.md", modify("done", V1, V3));
      git("add", "-A");
      git("commit", "-qm", "base");
      mkdirSync(join(dir, "systems/slack/docs/changes/archive"));
      git("mv", "systems/slack/docs/changes/260101-y", "systems/slack/docs/changes/archive/260101-y");
      write(CANON_PATH, canon(V3));
      expect(checkArchive(readSpecFilesAt(dir, "HEAD"), readSpecFiles(dir)).row).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Whitespace noise that the normalization of REQ-DLV-009 removes. */
const noisy = (text: string, crlf: boolean, trailing: boolean) => {
  let t = trailing ? text.replace(/\n/g, "  \n") : text;
  t = crlf ? t.replace(/\n/g, "\r\n") : t;
  return `${t}\n\n`;
};

describe("PROP-DLV-004", () => {
  it("PROP-DLV-004: archiving Y after X fails whenever X's After differs from Y's Before", () => {
    fc.assert(
      fc.property(
        bodyArb,
        fc.oneof(bodyArb, fc.constant(null)),
        bodyArb,
        fc.boolean(),
        fc.boolean(),
        (original, xAfterOrSame, yAfter, crlf, trailing) => {
          // X's After is either new text or the original with only whitespace noise.
          const xAfter = xAfterOrSame ?? noisy(original, crlf, trailing);
          const base: FileMap = new Map([
            [CANON_PATH, canon(xAfter)],
            ["systems/slack/docs/changes/260101-y/spec.md", modify("done", original, yAfter)],
          ]);
          const head: FileMap = new Map([
            [CANON_PATH, canon(yAfter)],
            ["systems/slack/docs/changes/archive/260101-y/spec.md", modify("done", original, yAfter)],
          ]);
          const norm = (s: string) =>
            s.replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n+$/, "");
          const differs = norm(xAfter) !== norm(original);
          const r = checkArchive(base, head);
          if (differs) expect(r.row).toBe(4);
          else expect(r.row).toBe(6);
        },
      ),
      { numRuns: 500 },
    );
  });
});

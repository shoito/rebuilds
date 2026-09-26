import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalize, parseDecisionTable, parseSpec } from "../src/parse-spec.ts";
import { readSpecFiles, specsFromFiles } from "../src/repo.ts";
import { CI_SPEC, ids, ROOT } from "./support.ts";

const DELTA = ids(`---
capability: messaging
status: in-progress
---

# Spec: sample

## ADDED Requirements

### REQ~MSG~001: first

Body.

\`\`\`md
### REQ~MSG~009: inside a code block
\`\`\`

#### Scenario: s

- Then ok

## MODIFIED Requirements

### REQ~MSG~002: changed

#### Before

Old text.

#### Scenario: old

#### After

New text.

## REMOVED Requirements

### REQ~MSG~003: gone

- reason: x

#### Before

Removed text.

## Decision Tables

### DT~MSG~001: table

| # | a | → b |
| --- | --- | --- |
| 1 | x | y |
| 2 | - | z |

## Design

### Not an ID
`);

describe("parse-spec", () => {
  it("REQ-DLV-006: reads IDs from ### headings and the section they are in", () => {
    const spec = parseSpec("x/spec.md", DELTA, "change");
    expect(spec.errors).toEqual([]);
    expect(spec.frontmatter).toEqual({ capability: "messaging", status: "in-progress" });
    expect(spec.entries.map((e) => [e.id, e.section])).toEqual([
      [ids("REQ~MSG~001"), "ADDED"],
      [ids("REQ~MSG~002"), "MODIFIED"],
      [ids("REQ~MSG~003"), "REMOVED"],
      [ids("DT~MSG~001"), "ADDED"],
    ]);
  });

  it("REQ-DLV-006: headings inside fenced code blocks are not definitions (Q1)", () => {
    const spec = parseSpec("x/spec.md", DELTA, "change");
    expect(spec.entries.map((e) => e.id)).not.toContain(ids("REQ~MSG~009"));
    expect(spec.entries[0]!.body).toContain(ids("### REQ~MSG~009"));
  });

  it("REQ-DLV-009: extracts Before and After of MODIFIED and REMOVED, including their scenarios", () => {
    const [, modified, removed] = parseSpec("x/spec.md", DELTA, "change").entries;
    expect(normalize(modified!.before!)).toBe("\nOld text.\n\n#### Scenario: old");
    expect(normalize(modified!.after!)).toBe("\nNew text.");
    expect(normalize(removed!.before!)).toBe("\nRemoved text.");
  });

  it("REQ-DLV-009: a MODIFIED entry without Before / After is reported with its location", () => {
    const text = ids("## MODIFIED Requirements\n\n### REQ~MSG~002: x\n\nno before\n");
    const spec = parseSpec("x/spec.md", text, "change");
    expect(spec.errors.map((e) => [e.line, e.message])).toEqual([
      [3, expect.stringContaining("Before")],
      [3, expect.stringContaining("After")],
    ]);
  });

  it("REQ-DLV-007: a malformed ID heading is an error instead of being ignored", () => {
    const spec = parseSpec("x/spec.md", ids("## ADDED Requirements\n\n### REQ~MSG~01: typo\n"), "change");
    expect(spec.entries).toEqual([]);
    expect(spec.errors[0]).toMatchObject({ line: 3, message: expect.stringContaining("malformed") });
  });

  it("REQ-DLV-006: canonical specs put every ID in the CANONICAL section", () => {
    const spec = parseSpec("s/spec.md", ids("## Requirements\n\n### REQ~MSG~001: a\n\n## Decision Tables\n\n### DT~MSG~001: b\n"), "canonical");
    expect(spec.entries.map((e) => e.section)).toEqual(["CANONICAL", "CANONICAL"]);
  });

  it("REQ-DLV-009: normalization ignores CRLF, trailing spaces and trailing blank lines only (Q3, Q4)", () => {
    expect(normalize("a  \r\nb\t\r\n\r\n\n")).toBe(normalize("a\nb"));
    expect(normalize("（注）")).not.toBe(normalize("(注)"));
    expect(normalize("a\n\nb")).not.toBe(normalize("a\nb"));
    expect(normalize("\na")).not.toBe(normalize("a"));
  });

  it("REQ-DLV-006: reads the decision tables of the approved spec", () => {
    const table = parseDecisionTable(readFileSync(CI_SPEC, "utf8"), "DT-DLV-003");
    expect(table.header[0]).toBe("#");
    expect(table.rows.map((r) => r[0])).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  });

  it("REQ-DLV-006: parses every existing spec.md without errors and finds every ID heading", () => {
    const specs = specsFromFiles(readSpecFiles(ROOT));
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(s.parsed.errors, s.path).toEqual([]);
      const text = readFileSync(join(ROOT, s.path), "utf8");
      const headings = text.split("\n").filter((l) => /^### (REQ|PROP|DT)-/.test(l)).length;
      expect(s.parsed.entries.length, s.path).toBe(headings);
    }
    // Plan step 1: the specs of post-and-list-messages and of the two E1 delivery/infra changes.
    for (const change of ["260926-post-and-list-messages", "260926-ci-pipeline", "260926-terraform-foundation"]) {
      const s = specs.find((x) => x.path.includes(`/${change}/spec.md`));
      expect(s?.parsed.frontmatter?.status, change).toBe("approved");
      expect(s?.parsed.entries.length, change).toBeGreaterThan(5);
    }
  });
});

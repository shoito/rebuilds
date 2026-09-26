// Generators of spec.md sets for PROP-DLV-002..004 (quality.md 2.2).
import fc from "fast-check";
import type { SpecKind } from "../../src/repo.ts";

export const CAPABILITIES: [string, string][] = [
  ["messaging", "MSG"],
  ["channels", "CHN"],
  ["delivery", "DLV"],
  ["flags", "FLAG"],
];
export const PREFIXES = new Map([["slack", new Map(CAPABILITIES)], ["other", new Map(CAPABILITIES)]]);

export type Section = "CANONICAL" | "ADDED" | "MODIFIED" | "REMOVED";

export interface MEntry {
  id: string;
  section: Section;
  body: string;
  after?: string;
}

export interface MSpec {
  path: string;
  kind: SpecKind;
  /** null: no frontmatter at all. */
  status: string | null;
  capability: string;
  entries: MEntry[];
  crlf: boolean;
}

const LINES = [
  "システムは、投稿を保存しなければならない。",
  "| # | 条件 | → 結果 |\n| --- | --- | --- |\n| 1 | - | 成功 |",
  // A heading-like line in a code block must not count as a definition (Q1).
  "```md\n### REQ-MSG-001: 見出しに似た行\n```",
  "全角の　空白と（括弧）",
  "行末の空白   ",
  "#### Scenario: 例\n\n- Given 利用者\n- Then 成功する",
];

export const bodyArb = fc
  .array(fc.constantFrom(...LINES), { minLength: 1, maxLength: 3 })
  .map((parts) => `\n${parts.join("\n\n")}\n`);

/** Narrow number range so that collisions are frequent (quality.md 2.2). */
export const idArb = (prefix: string) =>
  fc
    .tuple(fc.constantFrom("REQ", "PROP", "DT"), fc.integer({ min: 1, max: 15 }))
    .map(([kind, n]) => `${kind}-${prefix}-${String(n).padStart(3, "0")}`);

export const STATUSES = ["draft", "approved", "in-progress", "done", "bogus"];

const entryArb = (prefix: string, sections: Section[]) =>
  fc.record({ id: idArb(prefix), section: fc.constantFrom(...sections), body: bodyArb, after: bodyArb });

function specArb(kind: SpecKind, index: number) {
  return fc
    .record({
      system: fc.constantFrom("slack", "other"),
      cap: fc.constantFrom(...CAPABILITIES.slice(0, 2)),
      status: kind === "canonical" ? fc.constant("") : fc.constantFrom<string | null>(...STATUSES, null),
      crlf: fc.boolean(),
    })
    .chain(({ system, cap, status, crlf }) =>
      fc
        .array(entryArb(cap[1], kind === "canonical" ? ["CANONICAL"] : ["ADDED", "MODIFIED", "REMOVED"]), { maxLength: 8 })
        .map((entries): MSpec => {
          const path =
            kind === "canonical"
              ? `systems/${system}/docs/specs/${cap[0]}${index}/spec.md`
              : kind === "archive"
                ? `systems/${system}/docs/changes/archive/260101-a${index}/spec.md`
                : `systems/${system}/docs/changes/260101-c${index}/spec.md`;
          return { path, kind, status: kind === "canonical" ? "" : status, capability: cap[0], entries, crlf };
        }),
    );
}

export const specSetArb = fc
  .tuple(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 0, max: 6 }), fc.integer({ min: 0, max: 2 }))
  .chain(([c, x, a]) =>
    fc.tuple(
      fc.tuple(...Array.from({ length: c }, (_, i) => specArb("canonical", i))),
      fc.tuple(...Array.from({ length: x }, (_, i) => specArb("change", i))),
      fc.tuple(...Array.from({ length: a }, (_, i) => specArb("archive", i))),
    ),
  )
  .map(([c, x, a]) => [...c, ...x, ...a]);

export function render(spec: MSpec): string {
  const out: string[] = [];
  if (spec.status !== null) {
    out.push("---", `capability: ${spec.capability}`);
    if (spec.kind !== "canonical") out.push("change: 260101-x", `status: ${spec.status}`);
    out.push("---", "");
  }
  out.push("# Spec: generated", "");
  const section = (title: string, s: Section, block: (e: MEntry) => string[]) => {
    const es = spec.entries.filter((e) => e.section === s);
    if (es.length === 0) return;
    out.push(`## ${title}`, "");
    for (const e of es) out.push(`### ${e.id}: title`, ...block(e));
  };
  section("Requirements", "CANONICAL", (e) => [e.body]);
  section("ADDED Requirements", "ADDED", (e) => [e.body]);
  section("MODIFIED Requirements", "MODIFIED", (e) => ["", "#### Before", e.body, "#### After", e.after ?? "", ""]);
  section("REMOVED Requirements", "REMOVED", (e) => ["", "- 理由：不要", "", "#### Before", e.body]);
  out.push("## Design", "", "### 置き場所", "");
  const text = out.join("\n");
  return spec.crlf ? text.replace(/\n/g, "\r\n") : text;
}

export function toFiles(specs: MSpec[]): Map<string, string> {
  return new Map(specs.map((s) => [s.path, render(s)]));
}

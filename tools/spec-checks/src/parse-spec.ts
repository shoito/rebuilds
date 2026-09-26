// Parser for spec.md files (canonical specs and change deltas).
// See docs/templates/spec.md for the format.

export type Section = "CANONICAL" | "ADDED" | "MODIFIED" | "REMOVED";

export interface IdEntry {
  id: string;
  section: Section;
  /** 1-based line number of the heading. */
  line: number;
  /** Text after the heading line up to the next heading of level <= 3. */
  body: string;
  /** "#### Before" content (MODIFIED / REMOVED only). */
  before?: string;
  /** "#### After" content (MODIFIED only). */
  after?: string;
}

export interface Problem {
  path: string;
  line: number;
  message: string;
}

export interface ParsedSpec {
  path: string;
  frontmatter: Record<string, string> | null;
  entries: IdEntry[];
  errors: Problem[];
}

export const ID_PATTERN = /^(REQ|PROP|DT)-[A-Z]+-\d{3}$/;
const ID_HEADING = /^###\s+((?:REQ|PROP|DT)-[A-Z]+-\d{3})(?=[:\s]|$)/;
const ID_LIKE_HEADING = /^###\s+(REQ|PROP|DT)-/;

interface Heading {
  index: number;
  level: number;
  text: string;
}

/** Normalization from REQ-DLV-009: LF line endings, no trailing spaces, no trailing blank lines. */
export function normalize(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

export function parseFrontmatter(text: string): Record<string, string> | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0] !== "---") return null;
  const result: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "---") return result;
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) result[m[1]!] = m[2]!.trim();
  }
  return null;
}

/** Headings outside fenced code blocks. */
function findHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      const marker = f[1]!;
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) headings.push({ index: i, level: h[1]!.length, text: h[2]!.trim() });
  }
  return headings;
}

/** Lines after `headings[k]` up to the next heading with level <= maxLevel. */
function sliceBlock(lines: string[], headings: Heading[], k: number, maxLevel: number, end = lines.length): string {
  const start = headings[k]!.index + 1;
  let stop = end;
  for (let j = k + 1; j < headings.length; j++) {
    const h = headings[j]!;
    if (h.index >= end) break;
    if (h.level <= maxLevel) {
      stop = h.index;
      break;
    }
  }
  return lines.slice(start, stop).join("\n");
}

function sectionOf(text: string, kind: "canonical" | "change"): Section {
  if (kind === "canonical") return "CANONICAL";
  if (/^MODIFIED\b/.test(text)) return "MODIFIED";
  if (/^REMOVED\b/.test(text)) return "REMOVED";
  // "ADDED Requirements", and in changes the "Decision Tables" and
  // "Correctness Properties" sections, which add new DT-* / PROP-* IDs.
  return "ADDED";
}

export function parseSpec(path: string, text: string, kind: "canonical" | "change"): ParsedSpec {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const headings = findHeadings(lines);
  const entries: IdEntry[] = [];
  const errors: Problem[] = [];
  let section: Section = kind === "canonical" ? "CANONICAL" : "ADDED";

  for (let k = 0; k < headings.length; k++) {
    const h = headings[k]!;
    if (h.level === 2) section = sectionOf(h.text, kind);
    if (h.level !== 3) continue;
    const raw = `### ${h.text}`;
    const m = ID_HEADING.exec(raw);
    if (!m) {
      if (ID_LIKE_HEADING.test(raw)) {
        errors.push({ path, line: h.index + 1, message: `malformed ID heading (expected "### <REQ|PROP|DT>-<CAP>-NNN: ..."): ${raw}` });
      }
      continue;
    }
    const entry: IdEntry = { id: m[1]!, section, line: h.index + 1, body: sliceBlock(lines, headings, k, 3) };
    if (section === "MODIFIED" || section === "REMOVED") {
      const blockEnd = headings.slice(k + 1).find((x) => x.level <= 3)?.index ?? lines.length;
      for (let j = k + 1; j < headings.length && headings[j]!.index < blockEnd; j++) {
        const sub = headings[j]!;
        if (sub.level !== 4) continue;
        if (sub.text === "Before") entry.before = sliceBlock(lines, headings, j, 4, blockEnd);
        if (sub.text === "After") entry.after = sliceBlock(lines, headings, j, 4, blockEnd);
      }
      if (entry.before === undefined) {
        errors.push({ path, line: entry.line, message: `${entry.id} in ${section} has no "#### Before" section` });
      }
      if (section === "MODIFIED" && entry.after === undefined) {
        errors.push({ path, line: entry.line, message: `${entry.id} in MODIFIED has no "#### After" section` });
      }
    }
    entries.push(entry);
  }
  return { path, frontmatter: parseFrontmatter(text), entries, errors };
}

export interface DecisionTable {
  header: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Reads the first Markdown table in the block of `id` (used by table-driven tests). */
export function parseDecisionTable(text: string, id: string): DecisionTable {
  const spec = parseSpec("", text, "change");
  const entry = spec.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`decision table ${id} not found`);
  const lines = entry.body.split("\n");
  const start = lines.findIndex((l) => l.trim().startsWith("|"));
  if (start < 0 || !/^\s*\|[\s\-:|]+\|\s*$/.test(lines[start + 1] ?? "")) {
    throw new Error(`decision table ${id} has no Markdown table`);
  }
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) rows.push(splitRow(lines[i]!));
  return { header: splitRow(lines[start]!), rows };
}

// REQ-DLV-010: the ADR index in each decisions/README.md is generated from the ADR files.
import { parseFrontmatter } from "./parse-spec.ts";
import type { TextFile } from "./repo.ts";

export const START = "<!-- adr-index:start -->";
export const END = "<!-- adr-index:end -->";

/** `adrs` are the NNNN-*.md files of one decisions/ directory. */
export function renderIndex(adrs: TextFile[]): string {
  const rows = adrs
    .map((adr) => {
      const file = adr.path.split("/").pop()!;
      const num = /^(\d{4})-/.exec(file)?.[1];
      if (!num) return null;
      const title = /^# ADR-\d{4}:\s*(.*)$/m.exec(adr.text)?.[1]?.trim() ?? "";
      const status = parseFrontmatter(adr.text)?.status ?? "";
      return { num, line: `| [${num}](${file}) | ${title} | ${status} |` };
    })
    .filter((r) => r !== null)
    .sort((a, b) => a.num.localeCompare(b.num) || a.line.localeCompare(b.line));
  return ["| ADR | 決定 | 状態 |", "| --- | --- | --- |", ...rows.map((r) => r.line)].join("\n");
}

/** Replaces the text between the markers; throws when the markers are missing. */
export function replaceIndex(readme: string, table: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) throw new Error(`missing ${START} / ${END} markers`);
  return `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;
}

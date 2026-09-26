import { readFileSync } from "node:fs";
import { SPEC_PATH } from "./paths.ts";

export interface TableRow {
  /** The "#" column. */
  no: number;
  cells: string[];
}

/**
 * Reads the decision table that follows the `### <id>:` heading in spec.md.
 * Tests use this so that the spec, not a copy of it, drives table-driven tests
 * (docs/process.md section 6).
 */
export function readDecisionTable(id: string, specPath: string = SPEC_PATH): { header: string[]; rows: TableRow[] } {
  const lines = readFileSync(specPath, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`### ${id}:`));
  if (start === -1) throw new Error(`${id} not found in ${specPath}`);
  const tableLines: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("#")) break;
    if (l.startsWith("|")) tableLines.push(l);
    else if (tableLines.length > 0) break;
  }
  const split = (l: string): string[] =>
    l
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
  const [headerLine, , ...body] = tableLines;
  if (!headerLine) throw new Error(`${id} has no table`);
  return {
    header: split(headerLine),
    rows: body.map((l) => {
      const cells = split(l);
      return { no: Number(cells[0]), cells };
    }),
  };
}

/** Strips Markdown backticks from a cell. */
export function plain(cell: string): string {
  return cell.replaceAll("`", "");
}

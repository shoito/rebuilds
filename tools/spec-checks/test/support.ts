// Shared helpers for the tests.
//
// IDs written literally in *.test.ts files count as references for the traceability
// check (REQ-DLV-006). Tests therefore write made-up IDs with "~" instead of "-"
// (e.g. "REQ~MSG~001") and convert them with `ids()`, so that fixtures do not
// mark real requirements as tested or introduce undefined references.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDecisionTable, type DecisionTable } from "../src/parse-spec.ts";

export const ids = (text: string): string => text.replaceAll("~", "-");

export const ROOT = resolve(import.meta.dirname, "../../..");

// Table-driven tests read the decision tables from the approved spec (process.md 6).
// When the change is archived, point this at systems/slack/docs/specs/delivery/spec.md.
export const CI_SPEC = resolve(ROOT, "systems/slack/docs/changes/260926-ci-pipeline/spec.md");

export function loadTable(id: string): DecisionTable {
  return parseDecisionTable(readFileSync(CI_SPEC, "utf8"), id);
}

/** All combinations of the given value domains. */
export function combinations<T extends Record<string, unknown[]>>(domains: T): { [K in keyof T]: T[K][number] }[] {
  let result: Record<string, unknown>[] = [{}];
  for (const [key, values] of Object.entries(domains)) {
    result = result.flatMap((r) => values.map((v) => ({ ...r, [key]: v })));
  }
  return result as { [K in keyof T]: T[K][number] }[];
}

/**
 * Generic evaluation of a decision table read from spec.md: `matches(cell, column, facts)`
 * interprets one condition cell ("-" always matches). Returns the first matching row.
 */
export function firstRow<F>(
  table: DecisionTable,
  conditionColumns: number[],
  facts: F,
  matches: (cell: string, column: number, facts: F) => boolean,
): string[] | undefined {
  return table.rows.find((row) => conditionColumns.every((c) => row[c] === "-" || matches(row[c]!, c, facts)));
}

/** Maps a result cell of the delivery tables to an outcome. */
export function outcomeOf(cell: string): "fail" | "warn" | "ok" | "n/a" {
  if (cell.startsWith("失敗")) return "fail";
  if (cell.startsWith("警告")) return "warn";
  if (cell.startsWith("成功")) return "ok";
  if (cell.startsWith("対象外")) return "n/a";
  throw new Error(`unknown result cell: ${cell}`);
}

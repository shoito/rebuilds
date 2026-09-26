// Loads the documents the checks work on, either from the working tree or
// from an in-memory map of files (used for git revisions and tests).
import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSpec, type ParsedSpec } from "./parse-spec.ts";

export interface Finding {
  level: "error" | "warning";
  path: string;
  line: number;
  message: string;
}

export type SpecKind = "canonical" | "change" | "archive";

export interface SpecFile {
  path: string;
  kind: SpecKind;
  system: string;
  parsed: ParsedSpec;
}

export interface TextFile {
  path: string;
  text: string;
}

/** path -> content, paths relative to the repository root with "/" separators. */
export type FileMap = Map<string, string>;

const CANONICAL = /^systems\/([^/]+)\/docs\/specs\/.+\/spec\.md$/;
const ARCHIVE = /^systems\/([^/]+)\/docs\/changes\/archive\/[^/]+\/spec\.md$/;
const CHANGE = /^systems\/([^/]+)\/docs\/changes\/(?!archive\/)[^/]+\/spec\.md$/;
export const PLAN = /^systems\/([^/]+)\/docs\/changes\/(?!archive\/)[^/]+\/plan\.md$/;

export function classifySpec(path: string): { kind: SpecKind; system: string } | null {
  let m = CANONICAL.exec(path);
  if (m) return { kind: "canonical", system: m[1]! };
  m = ARCHIVE.exec(path);
  if (m) return { kind: "archive", system: m[1]! };
  m = CHANGE.exec(path);
  if (m) return { kind: "change", system: m[1]! };
  return null;
}

export function specsFromFiles(files: FileMap): SpecFile[] {
  const specs: SpecFile[] = [];
  for (const [path, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const c = classifySpec(path);
    if (!c) continue;
    specs.push({ path, ...c, parsed: parseSpec(path, text, c.kind === "canonical" ? "canonical" : "change") });
  }
  return specs;
}

/** Parses the capability -> prefix table in systems/<name>/docs/specs/README.md. */
export function parsePrefixTable(text: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\|\s*([a-z][a-z0-9-]*)\s*\|\s*`([A-Z]+)`\s*\|/.exec(line);
    if (m) table.set(m[1]!, m[2]!);
  }
  return table;
}

export interface Config {
  testFileGlobs: string[];
  testFileExcludes: string[];
  prefixTable: string;
}

export function loadConfig(toolDir: string): Config {
  return JSON.parse(readFileSync(join(toolDir, "config.json"), "utf8")) as Config;
}

function read(root: string, patterns: string[], exclude: string[] = ["**/node_modules/**"]): FileMap {
  const files: FileMap = new Map();
  for (const pattern of patterns) {
    for (const p of globSync(pattern, { cwd: root, exclude })) {
      const path = p.split("\\").join("/");
      files.set(path, readFileSync(join(root, path), "utf8"));
    }
  }
  return files;
}

/** Spec documents (canonical, changes, archive) in the working tree. */
export function readSpecFiles(root: string): FileMap {
  return read(root, ["systems/*/docs/specs/**/spec.md", "systems/*/docs/changes/**/spec.md"]);
}

export function readTestFiles(root: string, config: Config): TextFile[] {
  return toList(read(root, config.testFileGlobs, config.testFileExcludes));
}

export function readPlanFiles(root: string): TextFile[] {
  return toList(read(root, ["systems/*/docs/changes/*/plan.md"])).filter((f) => PLAN.test(f.path));
}

export function readPrefixTables(root: string, config: Config): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  for (const [path, text] of read(root, [`systems/*/${config.prefixTable}`])) {
    tables.set(path.split("/")[1]!, parsePrefixTable(text));
  }
  return tables;
}

/** Spec documents as they are at a git revision. */
export function readSpecFilesAt(root: string, ref: string): FileMap {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  const files: FileMap = new Map();
  for (const path of git("ls-tree", "-r", "--name-only", ref, "--", "systems").split("\n")) {
    if (classifySpec(path)) files.set(path, git("show", `${ref}:${path}`));
  }
  return files;
}

function toList(files: FileMap): TextFile[] {
  return [...files].map(([path, text]) => ({ path, text })).sort((a, b) => a.path.localeCompare(b.path));
}

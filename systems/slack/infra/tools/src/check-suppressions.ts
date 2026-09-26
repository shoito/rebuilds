// REQ-INFRA-016: inline Checkov suppressions need a reason and approvers.
// Required form: #checkov:skip=<CHECK_ID>:<reason> approved-by:@<ops>,@<dev-lead>
// Usage: node src/check-suppressions.ts [dir...]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { INFRA_DIR, toPosix } from "./lib/paths.ts";

const SKIP = /checkov:skip=([A-Z0-9_]+)(?::(.*))?$/;
const VALID = /^\s*(\S.*?)\s+approved-by:@[\w-]+,@[\w-]+\s*$/;

export interface Violation {
  file: string;
  line: number;
  check: string;
}

export function findInvalidSuppressions(src: string, file: string): Violation[] {
  const violations: Violation[] = [];
  src.split("\n").forEach((text, i) => {
    const m = SKIP.exec(text);
    if (!m) return;
    const rest = m[2] ?? "";
    if (!VALID.test(rest)) violations.push({ file, line: i + 1, check: m[1]! });
  });
  return violations;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    if (e === ".terraform" || e === "node_modules" || e.startsWith(".")) return [];
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return walk(p);
    return e.endsWith(".tf") ? [p] : [];
  });
}

export function checkDirs(dirs: string[], base: string = INFRA_DIR): Violation[] {
  return dirs.flatMap(walk).flatMap((f) => findInvalidSuppressions(readFileSync(f, "utf8"), toPosix(relative(base, f))));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dirs = args.length > 0 ? args.map((a) => resolve(a)) : [join(INFRA_DIR, "live"), join(INFRA_DIR, "modules")];
  const violations = checkDirs(dirs);
  for (const v of violations) {
    console.error(
      `::error file=${v.file},line=${v.line}::checkov:skip=${v.check} needs "<reason> approved-by:@<ops>,@<dev-lead>" (REQ-INFRA-016)`,
    );
  }
  if (violations.length > 0) process.exit(1);
  console.log("suppressions: every checkov skip has a reason and approvers");
}

// DT-INFRA-006: which root modules to plan, and which other checks to run, for
// a set of changed files (paths relative to the repository root).
// Usage: git diff --name-only <base>...HEAD | node src/affected-roots.ts
// Prints JSON: {"roots": [...], "moduleTests": [...], "static": bool, "policyTests": bool}
import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { moduleSources } from "./lib/hcl.ts";
import { INFRA_DIR, discoverModules, discoverRoots, listTfFiles, toPosix } from "./lib/paths.ts";

export const INFRA_PREFIX = "systems/slack/infra/";

export interface Affected {
  roots: string[];
  moduleTests: string[];
  static: boolean;
  policyTests: boolean;
}

export interface Layout {
  roots: string[];
  /** Module name -> module names it calls. */
  moduleCalls: Record<string, string[]>;
  /** Root -> module names it calls directly. */
  rootCalls: Record<string, string[]>;
}

/** Builds the module graph from the `source` of local module calls. */
export function readLayout(infraDir: string = INFRA_DIR): Layout {
  const modulesDir = join(infraDir, "modules");
  const callsOf = (dir: string): string[] =>
    listTfFiles(dir)
      .flatMap((f) => moduleSources(readFileSync(f, "utf8")))
      .map((s) => toPosix(relative(modulesDir, resolve(dir, s))))
      .filter((m) => m !== "" && !m.startsWith("..") && !m.includes("/"));
  const roots = discoverRoots(join(infraDir, "live"));
  const moduleCalls: Record<string, string[]> = {};
  for (const m of discoverModules(modulesDir)) moduleCalls[m] = callsOf(join(modulesDir, m));
  const rootCalls: Record<string, string[]> = {};
  for (const r of roots) rootCalls[r] = callsOf(join(infraDir, "live", r));
  return { roots, moduleCalls, rootCalls };
}

/** Roots that call module `m` directly or through other modules. */
export function rootsUsingModule(m: string, layout: Layout): string[] {
  const uses = (called: string[], seen: Set<string>): boolean =>
    called.some((c) => {
      if (c === m) return true;
      if (seen.has(c)) return false;
      seen.add(c);
      return uses(layout.moduleCalls[c] ?? [], seen);
    });
  return layout.roots.filter((r) => uses(layout.rootCalls[r] ?? [], new Set()));
}

/** Root path for a file under infra/live, following the <account>/<region>/<component> and global/<component> layout. */
export function rootOfLiveFile(pathInLive: string): string | undefined {
  const parts = pathInLive.split("/");
  if (parts[0] === "global") return parts.length >= 3 ? parts.slice(0, 2).join("/") : undefined;
  return parts.length >= 4 ? parts.slice(0, 3).join("/") : undefined;
}

const GLOBAL_CONFIG = new Set([".terraform-version", ".tflint.hcl", ".checkov.yaml"]);

/** Evaluates DT-INFRA-006 top-down for every file and returns the union. */
export function affected(changedFiles: string[], layout: Layout): Affected {
  const roots = new Set<string>();
  const moduleTests = new Set<string>();
  let staticChecks = false;
  let policyTests = false;
  for (const file of changedFiles) {
    if (file.startsWith(`${INFRA_PREFIX}live/`)) {
      // Row 1
      const root = rootOfLiveFile(file.slice(`${INFRA_PREFIX}live/`.length));
      // A root whose directory was deleted in this change has nothing left to plan.
      if (root && layout.roots.includes(root)) roots.add(root);
      staticChecks = true;
    } else if (file.startsWith(`${INFRA_PREFIX}modules/`)) {
      // Row 2
      const m = file.slice(`${INFRA_PREFIX}modules/`.length).split("/")[0]!;
      for (const r of rootsUsingModule(m, layout)) roots.add(r);
      moduleTests.add(m);
      staticChecks = true;
    } else if (file.startsWith(`${INFRA_PREFIX}policy/`)) {
      // Row 3
      policyTests = true;
    } else if (file.startsWith(INFRA_PREFIX) && GLOBAL_CONFIG.has(file.slice(INFRA_PREFIX.length))) {
      // Row 4
      for (const r of layout.roots) roots.add(r);
      staticChecks = true;
    } else if (dirname(file) === ".github/workflows" && /^infra-.*\.yml$/.test(basename(file))) {
      // Row 5
      for (const r of layout.roots) roots.add(r);
    }
    // Row 6: nothing.
  }
  return { roots: [...roots].sort(), moduleTests: [...moduleTests].sort(), static: staticChecks, policyTests };
}

if (import.meta.main) {
  const input = readFileSync(0, "utf8");
  const files = input.split("\n").map((l) => l.trim()).filter(Boolean);
  console.log(JSON.stringify(affected(files, readLayout())));
}

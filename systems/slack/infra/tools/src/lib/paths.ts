import { readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of systems/slack/infra. */
export const INFRA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Absolute path of the change spec that holds the decision tables. */
export const SPEC_PATH = resolve(
  INFRA_DIR,
  "../docs/changes/260926-terraform-foundation/spec.md",
);

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

export function listTfFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .map((f) => join(dir, f))
    .sort();
}

/**
 * Root modules are directories under live/ that contain .tf files, e.g.
 * "prod/ap-northeast-3/network" or "global/organization". Paths are relative to live/.
 */
export function discoverRoots(liveDir: string): string[] {
  const roots: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir);
    if (entries.some((e) => e.endsWith(".tf"))) {
      roots.push(toPosix(relative(liveDir, dir)));
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  if (existsSync(liveDir)) walk(liveDir);
  return roots.sort();
}

/** Module directories directly under modules/. */
export function discoverModules(modulesDir: string): string[] {
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir)
    .filter((e) => !e.startsWith(".") && statSync(join(modulesDir, e)).isDirectory())
    .sort();
}

// REQ-INFRA-018: every module under infra/modules must have terraform tests.
// Usage: node src/check-module-tests.ts [modulesDir]
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { INFRA_DIR, discoverModules } from "./lib/paths.ts";

export function modulesWithoutTests(modulesDir: string): string[] {
  return discoverModules(modulesDir).filter((m) => {
    const testsDir = join(modulesDir, m, "tests");
    return !existsSync(testsDir) || !readdirSync(testsDir).some((f) => f.endsWith(".tftest.hcl"));
  });
}

if (import.meta.main) {
  const modulesDir = resolve(process.argv[2] ?? join(INFRA_DIR, "modules"));
  const missing = modulesWithoutTests(modulesDir);
  for (const m of missing) console.error(`::error::modules/${m} has no tests/*.tftest.hcl (REQ-INFRA-018)`);
  if (missing.length > 0) process.exit(1);
  console.log("module tests: every module has terraform tests");
}

// PROP-INFRA-002 / REQ-INFRA-009: the disaster recovery roots (DT-INFRA-003 rows
// 1 and 2) must not depend on Tokyo. Every region the root and the local modules
// it calls refer to (backend, providers, data sources, terraform_remote_state,
// SSM reads, endpoints) must exclude ap-northeast-1, and every aws provider must
// set its region explicitly so it cannot fall back to a Tokyo default.
// Usage: node src/check-dr-independence.ts [liveDir]
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { moduleSources, providerBlocks, regionLiterals } from "./lib/hcl.ts";
import { INFRA_DIR, discoverRoots, listTfFiles, toPosix } from "./lib/paths.ts";
import { TOKYO, isDisasterRecoveryRoot } from "./state-location.ts";

export interface Finding {
  file: string;
  message: string;
}

/** Files of a directory plus every local module it calls, transitively. */
export function dependencyFiles(dir: string, seen: Set<string> = new Set()): string[] {
  const abs = resolve(dir);
  if (seen.has(abs)) return [];
  seen.add(abs);
  const files = listTfFiles(abs);
  const nested = files.flatMap((f) =>
    moduleSources(readFileSync(f, "utf8"))
      .filter((s) => s.startsWith("./") || s.startsWith("../"))
      .flatMap((s) => dependencyFiles(join(dirname(f), s), seen)),
  );
  return [...files, ...nested];
}

export function checkDrRoot(rootDir: string, displayBase: string = rootDir): Finding[] {
  const findings: Finding[] = [];
  for (const file of dependencyFiles(rootDir)) {
    const src = readFileSync(file, "utf8");
    const name = toPosix(relative(displayBase, file)) || file;
    for (const region of regionLiterals(src)) {
      if (region === TOKYO) {
        findings.push({ file: name, message: `refers to ${TOKYO}; disaster recovery roots must not depend on Tokyo (PROP-INFRA-002)` });
      }
    }
    for (const p of providerBlocks(src)) {
      if (p.name === "aws" && p.attrs["region"] === undefined) {
        findings.push({ file: name, message: `provider "aws" must set region explicitly (PROP-INFRA-002)` });
      }
    }
  }
  return findings;
}

export function checkAll(liveDir: string): Finding[] {
  return discoverRoots(liveDir)
    .filter(isDisasterRecoveryRoot)
    .flatMap((root) => checkDrRoot(join(liveDir, root), resolve(liveDir, "..")));
}

if (import.meta.main) {
  const liveDir = resolve(process.argv[2] ?? join(INFRA_DIR, "live"));
  const findings = checkAll(liveDir);
  for (const f of findings) console.error(`::error file=${f.file}::${f.message}`);
  if (findings.length > 0) process.exit(1);
  console.log("dr independence: no Tokyo dependency in disaster recovery roots");
}

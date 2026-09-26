// REQ-INFRA-007 / DT-INFRA-003: every root module's backend must point at the
// state bucket of the account/region the table assigns to it.
// Usage: node src/check-state-location.ts [liveDir] [accountsJson]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { backendBlocks } from "./lib/hcl.ts";
import { INFRA_DIR, discoverRoots, listTfFiles } from "./lib/paths.ts";
import { type AccountsFile, loadAccounts, stateBucketName, stateKey, stateLocation } from "./state-location.ts";

export function checkRoot(liveDir: string, root: string, accounts: AccountsFile): string[] {
  const loc = stateLocation(root);
  if (!loc.ok) return [`${root}: ${loc.reason}`];
  const expectedBucket = stateBucketName(loc.account, loc.region, accounts);
  const backends = listTfFiles(join(liveDir, root)).flatMap((f) => backendBlocks(readFileSync(f, "utf8")));
  if (backends.length !== 1) {
    return [`${root}: expected exactly one backend block, found ${backends.length}`];
  }
  const b = backends[0]!;
  const errors: string[] = [];
  const hint = `expected bucket "${expectedBucket}" in ${loc.region} (DT-INFRA-003 #${loc.row})`;
  if (b.type !== "s3") errors.push(`${root}: backend must be "s3", got "${b.type}"; ${hint}`);
  if (b.attrs["region"] !== loc.region) {
    errors.push(`${root}: backend region is "${String(b.attrs["region"])}" but must be "${loc.region}"; ${hint}`);
  }
  if (b.attrs["bucket"] !== undefined && b.attrs["bucket"] !== expectedBucket) {
    errors.push(`${root}: backend bucket is "${String(b.attrs["bucket"])}"; ${hint}`);
  }
  if (b.attrs["key"] !== stateKey(root)) {
    errors.push(`${root}: backend key must be "${stateKey(root)}", got "${String(b.attrs["key"])}"`);
  }
  if (b.attrs["use_lockfile"] !== true) errors.push(`${root}: backend must set use_lockfile = true (REQ-INFRA-008)`);
  if (b.attrs["dynamodb_table"] !== undefined) errors.push(`${root}: backend must not set dynamodb_table (REQ-INFRA-008)`);
  return errors;
}

export function checkAll(liveDir: string, accounts: AccountsFile): string[] {
  return discoverRoots(liveDir).flatMap((root) => checkRoot(liveDir, root, accounts));
}

if (import.meta.main) {
  const liveDir = resolve(process.argv[2] ?? join(INFRA_DIR, "live"));
  const accounts = loadAccounts(process.argv[3] ?? join(INFRA_DIR, "accounts.tfvars.json"));
  const errors = checkAll(liveDir, accounts);
  for (const e of errors) console.error(`::error::${e}`);
  if (errors.length > 0) process.exit(1);
  console.log(`state location: ${discoverRoots(liveDir).length} root modules match DT-INFRA-003`);
}

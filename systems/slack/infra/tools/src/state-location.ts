// DT-INFRA-003: where the state of each root module lives, plus the CI context
// (account, role ARNs, GitHub environment) derived from it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INFRA_DIR } from "./lib/paths.ts";

export const ACCOUNTS = ["management", "security", "log-archive", "shared", "dev", "staging", "prod"] as const;
export type Account = (typeof ACCOUNTS)[number];

export const TOKYO = "ap-northeast-1";
export const OSAKA = "ap-northeast-3";

export type StateLocation =
  | { ok: true; row: number; account: Account; region: string }
  | { ok: false; row: 5; reason: string };

function isAccount(s: string): s is Account {
  return (ACCOUNTS as readonly string[]).includes(s);
}

/** Evaluates DT-INFRA-003 top-down for a root path relative to infra/live. */
export function stateLocation(root: string): StateLocation {
  const parts = root.split("/");
  if (parts.length === 3 && parts[0] === "prod" && parts[1] === OSAKA && parts[2] !== "") {
    return { ok: true, row: 1, account: "prod", region: OSAKA };
  }
  if (root === "global/edge") return { ok: true, row: 2, account: "prod", region: OSAKA };
  if (parts.length === 2 && parts[0] === "global" && parts[1] !== "") {
    return { ok: true, row: 3, account: "management", region: TOKYO };
  }
  if (parts.length === 3 && isAccount(parts[0]!) && parts[1] === TOKYO && parts[2] !== "") {
    return { ok: true, row: 4, account: parts[0], region: TOKYO };
  }
  return { ok: false, row: 5, reason: `unknown root module "${root}" (DT-INFRA-003 #5)` };
}

/** DT-INFRA-003 rows 1 and 2: roots applied during a Tokyo outage (REQ-INFRA-009). */
export function isDisasterRecoveryRoot(root: string): boolean {
  const loc = stateLocation(root);
  return loc.ok && (loc.row === 1 || loc.row === 2);
}

export interface AccountsFile {
  organization_id: string | null;
  account_ids: Record<Account, string | null>;
}

export function loadAccounts(path: string = join(INFRA_DIR, "accounts.tfvars.json")): AccountsFile {
  return JSON.parse(readFileSync(path, "utf8")) as AccountsFile;
}

export function stateBucketName(account: Account, region: string, accounts: AccountsFile): string {
  const id = accounts.account_ids[account] ?? `<${account} account id>`;
  return `slack-tfstate-${id}-${region}`;
}

export function stateKey(root: string): string {
  return `${root}/terraform.tfstate`;
}

/** GitHub environment used by the apply job (DT-INFRA-005 rows 6-9). */
export function applyEnvironment(account: Account): "dev" | "staging" | "prod" | "platform" {
  if (account === "dev" || account === "staging" || account === "prod") return account;
  return "platform";
}

export interface RootContext {
  root: string;
  account: Account;
  accountId: string | null;
  region: string;
  bucket: string;
  key: string;
  planRoleArn: string | null;
  applyRoleArn: string | null;
  environment: "dev" | "staging" | "prod" | "platform";
}

export function rootContext(root: string, accounts: AccountsFile = loadAccounts()): RootContext {
  const loc = stateLocation(root);
  if (!loc.ok) throw new Error(loc.reason);
  const id = accounts.account_ids[loc.account];
  return {
    root,
    account: loc.account,
    accountId: id,
    region: loc.region,
    bucket: stateBucketName(loc.account, loc.region, accounts),
    key: stateKey(root),
    planRoleArn: id ? `arn:aws:iam::${id}:role/tf-plan` : null,
    applyRoleArn: id ? `arn:aws:iam::${id}:role/tf-apply` : null,
    environment: applyEnvironment(loc.account),
  };
}

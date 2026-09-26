// Straightforward TypeScript implementation of DT-INFRA-007, used as the oracle
// for the Rego policy in the PROP-INFRA-003 property test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INFRA_DIR } from "./lib/paths.ts";
import type { PolicyException, PolicyInput, ResourceChange } from "./plan-policy.ts";

interface PolicyData {
  statefulTypes: Set<string>;
  workloadTypes: Set<string>;
  workloadPrefixes: string[];
  allowedBucketPrefixes: string[];
  approvers: { ops: Set<string>; devTechLead: Set<string> };
}

export function loadPolicyData(dataDir: string = join(INFRA_DIR, "policy/data")): PolicyData {
  const read = <T>(f: string): T => JSON.parse(readFileSync(join(dataDir, f), "utf8")) as T;
  const st = read<{ stateful_types: string[] }>("stateful_types.json");
  const mw = read<{ management_workload: { types: string[]; type_prefixes: string[]; allowed_bucket_prefixes: string[] } }>(
    "management_workload.json",
  );
  const ap = read<{ exception_approvers: { ops: string[]; dev_tech_lead: string[] } }>("exception_approvers.json");
  return {
    statefulTypes: new Set(st.stateful_types),
    workloadTypes: new Set(mw.management_workload.types),
    workloadPrefixes: mw.management_workload.type_prefixes,
    allowedBucketPrefixes: mw.management_workload.allowed_bucket_prefixes,
    approvers: { ops: new Set(ap.exception_approvers.ops), devTechLead: new Set(ap.exception_approvers.dev_tech_lead) },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXCEPTION_DAYS = 14;

function parseDay(s: unknown): number | undefined {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? undefined : t;
}

function sameActions(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

export function validException(rc: ResourceChange, e: PolicyException, input: PolicyInput, data: PolicyData): boolean {
  const today = parseDay(input.today);
  const expires = parseDay(e.expires);
  if (today === undefined || expires === undefined) return false;
  const days = (expires - today) / DAY_MS;
  return (
    e.root === input.root &&
    e.address === rc.address &&
    sameActions(e.actions, rc.change.actions) &&
    typeof e.reason === "string" &&
    e.reason.trim() !== "" &&
    data.approvers.ops.has(e.approved_by?.ops ?? "") &&
    data.approvers.devTechLead.has(e.approved_by?.dev_tech_lead ?? "") &&
    days >= 0 &&
    days <= MAX_EXCEPTION_DAYS
  );
}

function bucketName(rc: ResourceChange): string {
  const after = rc.change.after as { bucket?: unknown } | null | undefined;
  const before = rc.change.before as { bucket?: unknown } | null | undefined;
  if (typeof after?.bucket === "string") return after.bucket;
  if (typeof before?.bucket === "string") return before.bucket;
  return "";
}

/** DT-INFRA-007 row number for one resource_change (first match wins). */
export function referenceRow(rc: ResourceChange, input: PolicyInput, data: PolicyData): 1 | 2 | 3 | 4 | 5 {
  const stateful = data.statefulTypes.has(rc.type);
  const deletes = rc.change.actions.includes("delete");
  if (stateful && deletes && input.exceptions.some((e) => validException(rc, e, input, data))) return 1;
  if (stateful && deletes) return 2;
  if (stateful && sameActions(rc.change.actions, ["forget"])) return 3;
  if (input.account === "management") {
    const workload = data.workloadTypes.has(rc.type) || data.workloadPrefixes.some((p) => rc.type.startsWith(p));
    const allowedBucket =
      rc.type === "aws_s3_bucket" && data.allowedBucketPrefixes.some((p) => bucketName(rc).startsWith(p));
    if (workload && !allowedBucket) return 4;
  }
  return 5;
}

/** PROP-INFRA-003: the policy passes iff no resource_change falls into row 2 or row 4. */
export function referenceAllow(input: PolicyInput, data: PolicyData): boolean {
  return (input.plan.resource_changes ?? []).every((rc) => {
    const row = referenceRow(rc, input, data);
    return row !== 2 && row !== 4;
  });
}

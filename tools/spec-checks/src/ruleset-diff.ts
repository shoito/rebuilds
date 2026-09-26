// REQ-DLV-001 (content of .github/rulesets/main.json) and REQ-DLV-014 (drift).

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Rule {
  type: string;
  parameters?: Record<string, Json>;
}

export interface Ruleset {
  name?: string;
  target?: string;
  enforcement?: string;
  conditions?: Json;
  bypass_actors?: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
  rules?: Rule[];
}

/** Differences where `got` does not match `want`; keys absent from `want` are ignored. */
export function subsetDiff(want: unknown, got: unknown, path = ""): string[] {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) {
      return [`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
    }
    return want.flatMap((w, i) => subsetDiff(w, got[i], `${path}[${i}]`));
  }
  if (typeof want === "object" && want !== null) {
    if (typeof got !== "object" || got === null || Array.isArray(got)) {
      return [`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
    }
    return Object.entries(want).flatMap(([k, w]) => subsetDiff(w, (got as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return want === got ? [] : [`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
}

const actorKey = (a: { actor_id: number | null; actor_type: string; bypass_mode: string }) =>
  `${a.actor_type}:${a.actor_id}:${a.bypass_mode}`;

/** Compares the desired ruleset with the one returned by the GitHub REST API. */
export function diffRuleset(desired: Ruleset, actual: Ruleset | null): string[] {
  if (!actual) return [`ruleset "${desired.name}" does not exist`];
  const diffs = subsetDiff(
    { name: desired.name, target: desired.target, enforcement: desired.enforcement, conditions: desired.conditions },
    actual,
  );
  if (actual.bypass_actors === undefined) {
    diffs.push("bypass_actors: not returned by the API (the token needs admin read access to see them)");
  } else {
    const want = (desired.bypass_actors ?? []).map(actorKey).sort();
    const got = actual.bypass_actors.map(actorKey).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      diffs.push(`bypass_actors: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }
  const actualRules = new Map((actual.rules ?? []).map((r) => [r.type, r]));
  const desiredTypes = new Set((desired.rules ?? []).map((r) => r.type));
  for (const rule of desired.rules ?? []) {
    const got = actualRules.get(rule.type);
    if (!got) diffs.push(`rules.${rule.type}: missing`);
    else diffs.push(...subsetDiff(rule.parameters ?? {}, got.parameters ?? {}, `rules.${rule.type}`));
  }
  for (const type of actualRules.keys()) if (!desiredTypes.has(type)) diffs.push(`rules.${type}: not in .github/rulesets/main.json`);
  return diffs;
}

/** The protection that REQ-DLV-001 and the spec's Design table require of main.json. */
export const REQUIRED: Ruleset = {
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } },
  // ADR-0004: only repository admins may bypass, and only when merging a PR.
  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: true,
        required_review_thread_resolution: true,
        allowed_merge_methods: ["squash"],
      },
    },
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "ci-gate", integration_id: 15368 }] },
    },
    {
      type: "merge_queue",
      parameters: {
        merge_method: "SQUASH",
        max_entries_to_build: 5,
        min_entries_to_merge: 1,
        max_entries_to_merge: 5,
        check_response_timeout_minutes: 30,
      },
    },
  ],
};

/** Validates .github/rulesets/main.json against REQUIRED (DT-DLV-001 #2). */
export function validateRuleset(ruleset: Ruleset): string[] {
  return diffRuleset({ ...REQUIRED, name: ruleset.name }, ruleset).map((d) => `main.json ${d}`);
}

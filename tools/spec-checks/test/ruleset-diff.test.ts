import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffRuleset, subsetDiff, validateRuleset, type Ruleset } from "../src/ruleset-diff.ts";
import { ROOT } from "./support.ts";

const MAIN = JSON.parse(readFileSync(join(ROOT, ".github/rulesets/main.json"), "utf8")) as Ruleset;
const API = () => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/github/ruleset.json"), "utf8")) as Ruleset;
const rule = (r: Ruleset, type: string) => r.rules!.find((x) => x.type === type)!;

describe("REQ-DLV-001: main ruleset", () => {
  it("REQ-DLV-001: main.json has the protection values of the spec", () => {
    expect(validateRuleset(MAIN)).toEqual([]);
    expect(MAIN.enforcement).toBe("active");
    expect(MAIN.conditions).toEqual({ ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } });
    expect(MAIN.rules!.map((r) => r.type)).toEqual(["deletion", "non_fast_forward", "pull_request", "required_status_checks", "merge_queue"]);
    expect(rule(MAIN, "pull_request").parameters).toMatchObject({
      required_approving_review_count: 1,
      require_code_owner_review: true,
      dismiss_stale_reviews_on_push: true,
      required_review_thread_resolution: true,
      allowed_merge_methods: ["squash"],
    });
    expect(rule(MAIN, "required_status_checks").parameters!.required_status_checks).toEqual([{ context: "ci-gate", integration_id: 15368 }]);
    expect(rule(MAIN, "merge_queue").parameters).toMatchObject({
      merge_method: "SQUASH",
      max_entries_to_build: 5,
      min_entries_to_merge: 1,
      max_entries_to_merge: 5,
      check_response_timeout_minutes: 30,
    });
    // ADR-0004: only admins may bypass, and only by merging a PR (detected by REQ-DLV-015).
    expect(MAIN.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
  });

  it("REQ-DLV-001: weakened rulesets are rejected", () => {
    const weak = structuredClone(MAIN);
    rule(weak, "pull_request").parameters!.allowed_merge_methods = ["squash", "merge"];
    weak.bypass_actors = [...weak.bypass_actors!, { actor_id: 1, actor_type: "Integration", bypass_mode: "always" }];
    weak.rules = weak.rules!.filter((r) => r.type !== "non_fast_forward");
    const errors = validateRuleset(weak);
    expect(errors.join("\n")).toContain("allowed_merge_methods");
    expect(errors.join("\n")).toContain("bypass_actors");
    expect(errors.join("\n")).toContain("non_fast_forward: missing");
  });
});

describe("REQ-DLV-014: ruleset drift", () => {
  it("REQ-DLV-014: no drift when the API response matches main.json", () => {
    expect(diffRuleset(MAIN, API())).toEqual([]);
  });

  it("REQ-DLV-014: an approval count changed in the UI is reported as a difference", () => {
    const actual = API();
    rule(actual, "pull_request").parameters!.required_approving_review_count = 0;
    expect(diffRuleset(MAIN, actual)).toEqual(["rules.pull_request.required_approving_review_count: expected 1, got 0"]);
  });

  it("REQ-DLV-014: removed, added and disabled rules and a missing ruleset are reported", () => {
    const actual = API();
    actual.enforcement = "disabled";
    actual.rules = [...actual.rules!.filter((r) => r.type !== "merge_queue"), { type: "update" }];
    expect(diffRuleset(MAIN, actual)).toEqual([
      'enforcement: expected "active", got "disabled"',
      "rules.merge_queue: missing",
      "rules.update: not in .github/rulesets/main.json",
    ]);
    expect(diffRuleset(MAIN, null)).toEqual(['ruleset "main" does not exist']);
  });

  it("REQ-DLV-014: bypass actors that the token cannot see are reported instead of ignored", () => {
    const actual = API();
    delete actual.bypass_actors;
    expect(diffRuleset(MAIN, actual)).toEqual([expect.stringContaining("bypass_actors: not returned")]);
  });

  it("REQ-DLV-014: subsetDiff compares arrays exactly and ignores extra keys", () => {
    expect(subsetDiff({ a: [1, 2] }, { a: [1, 2], b: 3 })).toEqual([]);
    expect(subsetDiff({ a: [1, 2] }, { a: [1] })).toHaveLength(1);
  });
});

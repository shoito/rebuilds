import { describe, expect, it } from "vitest";
import { checkBranch, checkTitle, prNumberFromQueueRef, TYPES } from "../src/commit-title.ts";

const SYSTEMS = ["slack"];

describe("REQ-DLV-002: PR title format", () => {
  it("REQ-DLV-002: accepts a valid title", () => {
    expect(checkTitle("feat(slack): add message posting API", SYSTEMS)).toEqual([]);
  });

  it("REQ-DLV-002: accepts every type, the repo scope, breaking changes and revert", () => {
    for (const t of TYPES) expect(checkTitle(`${t}(repo): do something`, SYSTEMS), t).toEqual([]);
    expect(checkTitle("feat(slack)!: drop v1 API", SYSTEMS)).toEqual([]);
    expect(checkTitle('revert(slack): revert "feat(slack): add x"', SYSTEMS)).toEqual([]);
  });

  it("REQ-DLV-002: a missing scope fails and shows an example of the right form", () => {
    const [error] = checkTitle("feat: add message posting API", SYSTEMS);
    expect(error).toContain('e.g. "feat(slack): add message posting API"');
  });

  it("REQ-DLV-002: a Japanese title fails", () => {
    expect(checkTitle("docs(slack): 仕様を追加", SYSTEMS).join()).toContain("English");
    expect(checkTitle("docs(slack): add カタカナ", SYSTEMS)).not.toEqual([]);
  });

  it("REQ-DLV-002: a scope that is not a directory under systems/ fails", () => {
    expect(checkTitle("fix(discord): fix it", SYSTEMS).join()).toContain("unknown scope");
  });

  it("REQ-DLV-002: an unknown type or an empty subject fails", () => {
    expect(checkTitle("feature(slack): add x", SYSTEMS).join()).toContain("unknown type");
    expect(checkTitle("feat(slack): ", SYSTEMS)).not.toEqual([]);
  });

  it("REQ-DLV-002: reads the PR number of a merge queue branch", () => {
    expect(prNumberFromQueueRef("refs/heads/gh-readonly-queue/main/pr-123-0a1b2c")).toBe(123);
    expect(prNumberFromQueueRef("refs/heads/main")).toBeNull();
  });

  it("REQ-DLV-002: branch names are checked but only warned about (decision 2026-09-26)", () => {
    expect(checkBranch("slack/260926-ci-pipeline", SYSTEMS)).toBeNull();
    expect(checkBranch("feature/foo", SYSTEMS)).toContain("<system>/<YYMMDD-slug>");
  });
});

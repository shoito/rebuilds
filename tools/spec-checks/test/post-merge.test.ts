import { describe, expect, it } from "vitest";
import { labelIfBypassed, LABEL, mergedWithoutApproval } from "../src/post-merge.ts";
import { fakeGitHub } from "./fake-github.ts";

const review = (login: string, state: string) => ({ user: { login }, state });

// The acceptance test on a real repository (merging through the admin bypass) is
// done by hand when the ruleset is applied (plan step 11); these tests cover the logic.
describe("REQ-DLV-015: PRs merged through the admin bypass", () => {
  it("REQ-DLV-015: a PR merged with no approval needs a post-merge review", () => {
    expect(mergedWithoutApproval("shoito", [])).toBe(true);
    expect(mergedWithoutApproval("shoito", [review("shoito", "APPROVED"), review("bot", "COMMENTED")])).toBe(true);
  });

  it("REQ-DLV-015: an App PR approved by a person does not", () => {
    expect(mergedWithoutApproval("rebuilds-agent[bot]", [review("shoito", "APPROVED")])).toBe(false);
    expect(mergedWithoutApproval("app[bot]", [review("shoito", "APPROVED"), review("shoito", "COMMENTED")])).toBe(false);
  });

  it("REQ-DLV-015: a dismissed or superseded approval does not count", () => {
    expect(mergedWithoutApproval("app[bot]", [review("shoito", "APPROVED"), review("shoito", "DISMISSED")])).toBe(true);
    expect(mergedWithoutApproval("app[bot]", [review("shoito", "APPROVED"), review("shoito", "CHANGES_REQUESTED")])).toBe(true);
  });

  it("REQ-DLV-015: adds the review:post-merge label through the API", async () => {
    const { gh, calls } = fakeGitHub({
      "GET /repos/example-org/rebuilds/pulls/5": { user: { login: "shoito" }, merged: true },
      "GET /repos/example-org/rebuilds/pulls/5/reviews": [],
      "POST /repos/example-org/rebuilds/issues/5/labels": [{ name: LABEL }],
    });
    expect(await labelIfBypassed(gh, 5)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { labels: ["review:post-merge"] } });
  });

  it("REQ-DLV-015: does not label an approved PR", async () => {
    const { gh, calls } = fakeGitHub({
      "GET /repos/example-org/rebuilds/pulls/6": { user: { login: "app[bot]" }, merged: true },
      "GET /repos/example-org/rebuilds/pulls/6/reviews": [review("shoito", "APPROVED")],
    });
    expect(await labelIfBypassed(gh, 6)).toBe(false);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });
});

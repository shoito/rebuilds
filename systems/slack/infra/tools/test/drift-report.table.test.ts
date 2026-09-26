// DT-INFRA-008 table-driven tests (rows read from spec.md) and REQ-INFRA-019 scenarios.
// The GitHub API is replaced by an in-memory client.
import { describe, expect, it } from "vitest";
import { type IssueClient, LABELS, decide, driftTitle, errorTitle, report } from "../src/drift-report.ts";
import { plain, readDecisionTable } from "../src/lib/spec-table.ts";

class FakeIssues implements IssueClient {
  issues = new Map<number, { title: string; body: string; labels: string[]; open: boolean; comments: string[] }>();
  private next = 1;
  async findOpenIssue(title: string) {
    for (const [n, i] of this.issues) if (i.open && i.title === title) return n;
    return undefined;
  }
  async createIssue(title: string, body: string, labels: string[]) {
    const n = this.next++;
    this.issues.set(n, { title, body, labels, open: true, comments: [] });
    return n;
  }
  async comment(issue: number, body: string) {
    this.issues.get(issue)!.comments.push(body);
  }
  async close(issue: number) {
    this.issues.get(issue)!.open = false;
  }
}

const EXPECTED_KIND: [RegExp, string][] = [
  [/エラーの Issue/, "report-error"],
  [/閉じる/, "close-drift-issue"],
  [/何もしない/, "none"],
  [/コメントする/, "comment-drift-issue"],
  [/Issue を作る/, "create-drift-issue"],
];

describe("DT-INFRA-008: drift results", () => {
  const table = readDecisionTable("DT-INFRA-008");

  it("DT-INFRA-008: the table has five rows", () => {
    expect(table.rows.map((r) => r.no)).toEqual([1, 2, 3, 4, 5]);
  });

  for (const row of table.rows) {
    const [, exitCell, issueCell, actionCell] = row.cells.map(plain);
    const exitCode = Number(/^\d/.exec(exitCell!)![0]);
    const openIssueValues = issueCell === "-" ? [undefined, 7] : issueCell === "あり" ? [7] : [undefined];
    const expectedKind = EXPECTED_KIND.find(([re]) => re.test(actionCell!))![1];
    for (const open of openIssueValues) {
      it(`DT-INFRA-008 #${row.no}: exit ${exitCode}, open drift issue ${open ? "yes" : "no"} -> ${actionCell}`, () => {
        expect(decide(exitCode, open, undefined).kind).toBe(expectedKind);
      });
    }
  }
});

describe("REQ-INFRA-019: daily drift detection", () => {
  const root = "dev/ap-northeast-1/network";

  it("REQ-INFRA-019: a console change creates one drift issue with the summary and labels", async () => {
    const gh = new FakeIssues();
    await report({ root, exitCode: 2, summary: "~ aws_security_group.endpoints" }, gh, "2026-09-27");
    const all = [...gh.issues.values()];
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe(driftTitle(root));
    expect(all[0]!.body).toContain("aws_security_group.endpoints");
    expect(all[0]!.labels).toEqual(LABELS);
  });

  it("REQ-INFRA-019: drift on the next day comments on the existing issue instead of opening another", async () => {
    const gh = new FakeIssues();
    await report({ root, exitCode: 2, summary: "day 1" }, gh, "2026-09-27");
    await report({ root, exitCode: 2, summary: "day 2" }, gh, "2026-09-28");
    expect(gh.issues.size).toBe(1);
    expect(gh.issues.get(1)!.comments[0]).toContain("day 2");
  });

  it("REQ-INFRA-019: when the drift disappears the issue gets a resolution comment and is closed", async () => {
    const gh = new FakeIssues();
    await report({ root, exitCode: 2, summary: "drift" }, gh, "2026-09-27");
    await report({ root, exitCode: 0, summary: "" }, gh, "2026-09-28");
    const issue = gh.issues.get(1)!;
    expect(issue.open).toBe(false);
    expect(issue.comments.at(-1)).toContain("Resolved");
  });

  it("DT-INFRA-008 #3: plan errors open a drift-error issue, then comment on it", async () => {
    const gh = new FakeIssues();
    await report({ root, exitCode: 1, summary: "Error acquiring the state lock" }, gh, "2026-09-27");
    await report({ root, exitCode: 1, summary: "again" }, gh, "2026-09-28");
    const all = [...gh.issues.values()];
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe(errorTitle(root));
    expect(all[0]!.comments).toHaveLength(1);
  });

  it("DT-INFRA-008 #5: no drift and no issue does nothing", async () => {
    const gh = new FakeIssues();
    expect((await report({ root, exitCode: 0, summary: "" }, gh, "2026-09-27")).kind).toBe("none");
    expect(gh.issues.size).toBe(0);
  });
});

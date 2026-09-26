import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintWorkflow } from "../src/workflow-lint.ts";
import { ROOT } from "./support.ts";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const workflow = (body: string, top = "permissions:\n  contents: read\n") =>
  `name: x\non:\n  pull_request:\n${top}jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n${body}`;
const lint = (text: string, path = ".github/workflows/x.yml") => lintWorkflow({ path, text }, path.includes("/actions/"));

describe("REQ-DLV-013: workflow safety", () => {
  it("REQ-DLV-013: an action referenced by tag fails and asks for a SHA", () => {
    const findings = lint(workflow("      - uses: actions/checkout@v4\n"));
    expect(findings).toEqual([expect.objectContaining({ line: 10, message: expect.stringContaining("40-character commit SHA") })]);
  });

  it("REQ-DLV-013: SHA-pinned actions, local actions and digest-pinned images pass (Q10)", () => {
    const text = workflow(
      `      - uses: actions/checkout@${SHA} # v7.0.1\n      - uses: ./.github/actions/setup\n      - uses: docker://alpine@sha256:${"a".repeat(64)}\n`,
    );
    expect(lint(text)).toEqual([]);
  });

  it("REQ-DLV-013: branch refs, short SHAs and reusable workflows by tag fail", () => {
    expect(lint(workflow("      - uses: actions/checkout@main\n"))).toHaveLength(1);
    expect(lint(workflow("      - uses: actions/checkout@3d3c42e\n"))).toHaveLength(1);
    const reusable = "name: x\non: push\npermissions: {}\njobs:\n  a:\n    uses: org/repo/.github/workflows/w.yml@v1\n";
    expect(lint(reusable)).toHaveLength(1);
  });

  it("REQ-DLV-013: a workflow without top-level permissions fails", () => {
    expect(lint(workflow(`      - run: echo\n`, "")).map((f) => f.message)).toEqual([expect.stringContaining("top-level `permissions`")]);
  });

  it("REQ-DLV-013: write-all fails at the top level and in a job", () => {
    expect(lint(workflow("      - run: echo\n", "permissions: write-all\n"))).toHaveLength(1);
    const job = "name: x\non: push\npermissions: {}\njobs:\n  a:\n    permissions: write-all\n    runs-on: x\n    steps:\n      - run: echo\n";
    expect(lint(job)).toHaveLength(1);
  });

  it("REQ-DLV-013: pull_request_target fails in any form of `on`", () => {
    const steps = "permissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n";
    expect(lint(`on: pull_request_target\n${steps}`)).toHaveLength(1);
    expect(lint(`on: [push, pull_request_target]\n${steps}`)).toHaveLength(1);
    expect(lint(`on:\n  pull_request_target:\n    types: [opened]\n${steps}`)).toHaveLength(1);
  });

  it("REQ-DLV-013: composite actions are checked for pinning but not for permissions", () => {
    const action = "name: a\nruns:\n  using: composite\n  steps:\n    - uses: actions/setup-node@v4\n";
    expect(lint(action, ".github/actions/a/action.yml")).toHaveLength(1);
  });

  it("REQ-DLV-013: the workflows and actions of this repository pass", () => {
    const files = globSync(".github/{workflows/*.yml,actions/**/action.yml}", { cwd: ROOT });
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const path of files) expect(lint(readFileSync(join(ROOT, path), "utf8"), path), path).toEqual([]);
  });
});

// Entry point: node tools/spec-checks/src/cli.ts <command> [options]
// Modules are imported per command so that commands without npm dependencies
// (changes, gate, title, hooks) run without `pnpm install`.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, globSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Finding, TextFile } from "./repo.ts";

const TOOL_DIR = resolve(import.meta.dirname, "..");
const ROOT = resolve(TOOL_DIR, "../..");

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

function report(findings: Finding[]): { errors: number; warnings: number } {
  const escape = (s: string) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const f of findings) {
    const where = f.path ? `${f.path}${f.line ? `:${f.line}` : ""}` : "";
    if (process.env.GITHUB_ACTIONS) {
      const loc = f.path && f.line ? ` file=${f.path},line=${f.line}` : "";
      console.log(`::${f.level}${loc}::${escape(`${where} ${f.message}`)}`);
    } else {
      console.log(`${f.level}: ${where} ${f.message}`);
    }
  }
  return {
    errors: findings.filter((f) => f.level === "error").length,
    warnings: findings.filter((f) => f.level === "warning").length,
  };
}

function summary(markdown: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function output(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

function systems(): string[] {
  return readdirSync(join(ROOT, "systems"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function decisionsDirs(): string[] {
  return ["docs/decisions", ...globSync("systems/*/docs/decisions", { cwd: ROOT })].sort();
}

function adrFiles(dir: string): TextFile[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .map((f) => ({ path: `${dir}/${f}`, text: readFileSync(join(ROOT, dir, f), "utf8") }));
}

function github() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be set");
  return import("./github.ts").then(({ GitHub }) => new GitHub(repo, token));
}

async function adrIndex(check: boolean): Promise<Finding[]> {
  const { renderIndex, replaceIndex } = await import("./adr-index.ts");
  const findings: Finding[] = [];
  for (const dir of decisionsDirs()) {
    const path = `${dir}/README.md`;
    const current = readFileSync(join(ROOT, path), "utf8");
    let next: string;
    try {
      next = replaceIndex(current, renderIndex(adrFiles(dir)));
    } catch (e) {
      findings.push({ level: "error", path, line: 1, message: (e as Error).message });
      continue;
    }
    if (next === current) continue;
    if (check) {
      findings.push({
        level: "error",
        path,
        line: 1,
        message: "ADR index is out of date. Run: pnpm --dir tools/spec-checks gen:adr-index",
      });
    } else {
      writeFileSync(join(ROOT, path), next);
      console.log(`updated ${path}`);
    }
  }
  return findings;
}

async function check(base: string, warningsFile: string | undefined): Promise<number> {
  const repo = await import("./repo.ts");
  const { checkConflicts, checkPrefixes, checkAdrNumbers } = await import("./duplicates.ts");
  const { checkTrace, checkReferences } = await import("./trace.ts");
  const { checkArchive } = await import("./archive.ts");
  const config = repo.loadConfig(TOOL_DIR);
  const specFiles = repo.readSpecFiles(ROOT);
  const specs = repo.specsFromFiles(specFiles);
  const tests = repo.readTestFiles(ROOT, config);
  const trace = checkTrace(specs, tests);
  const archive = checkArchive(repo.readSpecFilesAt(ROOT, base), specFiles);
  const findings = [
    ...specs.flatMap((s) => s.parsed.errors.map((e): Finding => ({ level: "error", ...e }))),
    ...checkConflicts(specs),
    ...checkPrefixes(specs, repo.readPrefixTables(ROOT, config)),
    ...decisionsDirs().flatMap((d) => checkAdrNumbers(adrFiles(d))),
    ...trace.findings,
    ...checkReferences(specs, tests, repo.readPlanFiles(ROOT)),
    ...(await adrIndex(true)),
    ...archive.findings,
  ];
  const { errors, warnings } = report(findings);
  const lines = [
    "## Spec checks",
    "",
    `- ${specs.length} spec files, ${tests.length} test files, base ${base}`,
    `- errors: ${errors}, warnings: ${warnings}, archive check: DT-DLV-005 #${archive.row}`,
    "",
    `Unreferenced IDs of draft / approved changes (DT-DLV-003 #4, not a failure): ${trace.pending.length}`,
    "",
    trace.pending.length ? `<details><summary>IDs</summary>\n\n${trace.pending.join(", ")}\n\n</details>` : "",
  ];
  summary(lines.join("\n"));
  console.log(`\n${errors} error(s), ${warnings} warning(s); ${trace.pending.length} unreferenced ID(s) in draft/approved changes`);
  if (warningsFile) {
    const w = findings.filter((f) => f.level === "warning");
    writeFileSync(warningsFile, w.length ? ["Spec check warnings:", "", ...w.map((f) => `- \`${f.path}:${f.line}\` ${f.message}`)].join("\n") : "");
  }
  return errors > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      check: { type: "boolean" },
      required: { type: "string" },
      "warnings-file": { type: "string" },
    },
  });

  switch (command) {
    case "check":
      return check(values.base ?? "main", values["warnings-file"]);

    case "gen:adr-index":
      return report(await adrIndex(values.check ?? false)).errors > 0 ? 1 : 0;

    case "title": {
      const { checkTitle, checkBranch, prNumberFromQueueRef } = await import("./commit-title.ts");
      let title = process.env.PR_TITLE ?? positionals[0] ?? "";
      const queueRef = process.env.QUEUE_REF;
      if (!title && queueRef) {
        const pr = prNumberFromQueueRef(queueRef);
        if (pr === null) throw new Error(`cannot find the PR number in ${queueRef}`);
        title = (await (await github()).get<{ title: string }>(`/repos/{repo}/pulls/${pr}`)).title;
      }
      const branch = process.env.PR_BRANCH;
      const warning = branch ? checkBranch(branch, systems()) : null;
      const errors = checkTitle(title, systems());
      return report([
        ...(warning ? [{ level: "warning" as const, path: "", line: 0, message: warning }] : []),
        ...errors.map((message) => ({ level: "error" as const, path: "", line: 0, message })),
      ]).errors > 0
        ? 1
        : 0;
    }

    case "changes": {
      const { planJobs } = await import("./changes.ts");
      if (!values.base) throw new Error("--base is required");
      const files = git("diff", "--name-only", "--no-renames", values.base, "HEAD").split("\n").filter(Boolean);
      const plan = planJobs(files, existsSync(join(ROOT, ".github/workflows/infra-pr.yml")));
      console.log(`${files.length} changed file(s)`);
      output({
        targets: JSON.stringify(plan.targets),
        "slack-scope": plan.slack,
        "hooks-scope": plan.hooks,
        "required-hooks": plan.requiredHooks.join(","),
      });
      return 0;
    }

    case "hooks": {
      const { missingHooks, definedScripts } = await import("./changes.ts");
      const required = (values.required ?? "").split(",").filter(Boolean) as Parameters<typeof missingHooks>[0];
      const missing = missingHooks(required, definedScripts(join(ROOT, "systems/slack")));
      return report(missing.map((message) => ({ level: "error", path: "", line: 0, message }))).errors > 0 ? 1 : 0;
    }

    case "gate": {
      const { judge } = await import("./gate.ts");
      const result = judge(JSON.parse(process.env.NEEDS ?? "{}"));
      console.log(result.summary);
      summary(`## ci-gate\n\n${result.summary}`);
      return result.pass ? 0 : 1;
    }

    case "workflow-lint": {
      const { lintWorkflow, runActionlint } = await import("./workflow-lint.ts");
      const { validateRuleset } = await import("./ruleset-diff.ts");
      const files = globSync(".github/{workflows/*.{yml,yaml},actions/**/action.{yml,yaml}}", { cwd: ROOT }).sort();
      const findings = [
        ...runActionlint(ROOT),
        ...files.flatMap((path) =>
          lintWorkflow({ path, text: readFileSync(join(ROOT, path), "utf8") }, path.startsWith(".github/actions/")),
        ),
        ...validateRuleset(JSON.parse(readFileSync(join(ROOT, ".github/rulesets/main.json"), "utf8"))).map(
          (message): Finding => ({ level: "error", path: ".github/rulesets/main.json", line: 1, message }),
        ),
      ];
      console.log(`${files.length} workflow/action file(s) checked`);
      return report(findings).errors > 0 ? 1 : 0;
    }

    case "ruleset-drift": {
      const { diffRuleset } = await import("./ruleset-diff.ts");
      const gh = await github();
      const desired = JSON.parse(readFileSync(join(ROOT, ".github/rulesets/main.json"), "utf8"));
      const list = await gh.get<{ id: number; name: string }[]>("/repos/{repo}/rulesets?per_page=100&includes_parents=false");
      const found = list.find((r) => r.name === desired.name);
      const actual = found ? await gh.get<Record<string, unknown>>(`/repos/{repo}/rulesets/${found.id}`) : null;
      const diffs = diffRuleset(desired, actual);
      if (diffs.length === 0) {
        console.log("no drift");
        return 0;
      }
      const body = [
        "The `main` ruleset on GitHub differs from `.github/rulesets/main.json` (REQ-DLV-014):",
        "",
        ...diffs.map((d) => `- ${d}`),
      ].join("\n");
      console.log(body);
      const issue = await gh.ensureIssue("Ruleset drift: main", body, ["area:delivery", "source:alert", "needs:ops"]);
      console.log(`issue #${issue.number} ${issue.action}`);
      return 0;
    }

    case "ci-duration": {
      const { measure } = await import("./ci-duration.ts");
      const r = await measure(await github(), new Date());
      console.log(`p90 ${r.p90.toFixed(1)} min over ${r.runs} run(s); exceeded: ${r.exceeded}`);
      return 0;
    }

    case "post-merge": {
      const { labelIfBypassed, LABEL } = await import("./post-merge.ts");
      const pr = Number(positionals[0]);
      const labeled = await labelIfBypassed(await github(), pr);
      console.log(labeled ? `labeled #${pr} with ${LABEL}` : `#${pr} was approved; no label`);
      return 0;
    }

    default:
      console.error(
        "usage: cli.ts <check [--base <ref>] | gen:adr-index [--check] | title | changes --base <ref> | hooks --required <tasks> | gate | workflow-lint | ruleset-drift | ci-duration | post-merge <pr>>",
      );
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));

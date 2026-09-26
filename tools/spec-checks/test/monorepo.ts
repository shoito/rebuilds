// Temporary git repositories with a pnpm + Turborepo workspace at systems/slack,
// used to check what the CI would run (REQ-DLV-003, REQ-DLV-011, PROP-DLV-001).
import { execFileSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planJobs } from "../src/changes.ts";
import { ROOT } from "./support.ts";

const TURBO = join(ROOT, "tools/spec-checks/node_modules/.bin/turbo");
const FIXTURE = join(import.meta.dirname, "fixtures/monorepo");

/** The real workspace configuration of systems/slack (not the lockfile, which lists no packages yet). */
export function slackConfig(): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of ["package.json", "pnpm-workspace.yaml", "turbo.json"]) {
    files.set(`systems/slack/${f}`, readFileSync(join(ROOT, "systems/slack", f), "utf8"));
  }
  return files;
}

/** slackConfig() plus apps/api -> packages/contract, packages/db (quality.md 3). */
export function fixtureMonorepo(): Map<string, string> {
  const files = slackConfig();
  for (const p of globSync("**/*", { cwd: FIXTURE, withFileTypes: true })) {
    if (!p.isFile()) continue;
    const abs = join(p.parentPath, p.name);
    files.set(`systems/slack/${abs.slice(FIXTURE.length + 1)}`, readFileSync(abs, "utf8"));
  }
  return files;
}

export class TempRepo {
  readonly dir = mkdtempSync(join(tmpdir(), "spec-checks-"));

  constructor(files: Map<string, string>) {
    this.git("init", "-q");
    this.write(files);
    this.commit("base");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: this.dir,
      encoding: "utf8",
    });
  }

  write(files: Map<string, string>): void {
    for (const [path, text] of files) {
      mkdirSync(dirname(join(this.dir, path)), { recursive: true });
      writeFileSync(join(this.dir, path), text);
    }
  }

  commit(message: string): string {
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD").trim();
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Packages Turborepo would run `tasks` in, the way the Slack jobs of ci.yml call it. */
  turbo(tasks: string[], base: string, affected: boolean): string[] {
    const out = execFileSync(TURBO, ["run", ...tasks, ...(affected ? ["--affected"] : []), "--dry=json"], {
      cwd: join(this.dir, "systems/slack"),
      encoding: "utf8",
      env: { ...process.env, TURBO_SCM_BASE: base, TURBO_TELEMETRY_DISABLED: "1", TURBO_NO_UPDATE_NOTIFIER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Packages without the script appear with command "<NONEXISTENT>" and do not run.
    const tasksRun = (JSON.parse(out) as { tasks: { package: string; command: string }[] }).tasks;
    const packages = tasksRun.filter((t) => t.package !== "//" && t.command !== "<NONEXISTENT>").map((t) => t.package);
    return [...new Set(packages)].sort();
  }

  /** Changed files since `base` -> DT-DLV-001 -> the packages the Slack jobs check. */
  checkedPackages(base: string, tasks = ["test"]): string[] {
    const files = this.git("diff", "--name-only", "--no-renames", base, "HEAD").split("\n").filter(Boolean);
    const plan = planJobs(files, false);
    if (plan.slack === "none") return [];
    return this.turbo(tasks, base, plan.slack === "affected");
  }
}

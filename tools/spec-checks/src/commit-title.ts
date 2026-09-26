// REQ-DLV-002: PR title (= squash commit message) format.

export const TYPES = ["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore", "revert"];
const TITLE = /^([a-z]+)\(([^()\s]+)\)(!)?: (\S.*)$/;
const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

/** Returns error messages; empty when the title is valid. `systems` are the directory names under systems/. */
export function checkTitle(title: string, systems: string[]): string[] {
  const scopes = [...systems, "repo"];
  const example = `Expected "<type>(<scope>): <subject>", e.g. "feat(${systems[0] ?? "slack"}): add message posting API". type: ${TYPES.join(", ")}; scope: ${scopes.join(", ")}.`;
  const errors: string[] = [];
  const m = TITLE.exec(title);
  if (!m) {
    errors.push(`PR title "${title}" is not a Conventional Commit with a scope. ${example}`);
  } else {
    if (!TYPES.includes(m[1]!)) errors.push(`unknown type "${m[1]}". ${example}`);
    if (!scopes.includes(m[2]!)) errors.push(`unknown scope "${m[2]}" (no systems/${m[2]}/). ${example}`);
  }
  if (JAPANESE.test(title)) errors.push("PR title must be in English (no hiragana, katakana or kanji).");
  return errors;
}

/** ADR-0002 branch naming; only a warning (decision 2026-09-26). */
export function checkBranch(branch: string, systems: string[]): string | null {
  const m = /^([^/]+)\/\d{6}-[a-z0-9-]+$/.exec(branch);
  if (m && systems.includes(m[1]!)) return null;
  return `branch "${branch}" does not follow <system>/<YYMMDD-slug> (ADR-0002)`;
}

/** Merge queue branches look like gh-readonly-queue/main/pr-123-<sha>. */
export function prNumberFromQueueRef(ref: string): number | null {
  const m = /gh-readonly-queue\/[^/]+\/pr-(\d+)-/.exec(ref);
  return m ? Number(m[1]) : null;
}

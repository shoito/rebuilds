// REQ-DLV-013: safety checks for .github/workflows and .github/actions.
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import type { Finding, TextFile } from "./repo.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const PINNED_ACTION = /^[^@\s]+@[0-9a-f]{40}$/;
const PINNED_IMAGE = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

function usesOf(doc: Obj): string[] {
  const uses: string[] = [];
  const steps = (s: unknown) => {
    if (Array.isArray(s)) for (const step of s) if (isObj(step) && typeof step.uses === "string") uses.push(step.uses);
  };
  if (isObj(doc.jobs)) {
    for (const job of Object.values(doc.jobs)) {
      if (!isObj(job)) continue;
      if (typeof job.uses === "string") uses.push(job.uses);
      steps(job.steps);
    }
  }
  if (isObj(doc.runs)) steps(doc.runs.steps);
  return uses;
}

function events(on: unknown): string[] {
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.filter((e): e is string => typeof e === "string");
  if (isObj(on)) return Object.keys(on);
  return [];
}

function lineOf(text: string, needle: string): number {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  return i < 0 ? 1 : i + 1;
}

/** Checks one workflow (or composite action, when `isAction`) file. */
export function lintWorkflow(file: TextFile, isAction: boolean): Finding[] {
  const findings: Finding[] = [];
  const err = (line: number, message: string) => findings.push({ level: "error", path: file.path, line, message });
  let doc: unknown;
  try {
    doc = parse(file.text);
  } catch (e) {
    err(1, `invalid YAML: ${(e as Error).message}`);
    return findings;
  }
  if (!isObj(doc)) return findings;

  for (const u of usesOf(doc)) {
    if (u.startsWith("./")) continue;
    if (u.startsWith("docker://") ? !PINNED_IMAGE.test(u) : !PINNED_ACTION.test(u)) {
      err(lineOf(file.text, u), `"${u}" must be pinned to a full 40-character commit SHA (e.g. owner/repo@<sha> # vX.Y.Z)`);
    }
  }
  if (isAction) return findings;

  if (!("permissions" in doc)) err(1, "missing top-level `permissions` (set the least privilege, e.g. contents: read)");
  const perms = [doc.permissions, ...(isObj(doc.jobs) ? Object.values(doc.jobs).map((j) => (isObj(j) ? j.permissions : undefined)) : [])];
  if (perms.includes("write-all")) err(lineOf(file.text, "write-all"), "`permissions: write-all` is not allowed");
  if (events(doc.on).includes("pull_request_target")) {
    err(lineOf(file.text, "pull_request_target"), "`pull_request_target` is not allowed");
  }
  return findings;
}

interface ActionlintError {
  message: string;
  filepath: string;
  line: number;
  kind: string;
}

/** Runs actionlint in `root`; a missing binary is an error so CI cannot silently skip it. */
export function runActionlint(root: string): Finding[] {
  const r = spawnSync("actionlint", ["-format", "{{json .}}"], { cwd: root, encoding: "utf8" });
  if (r.error) return [{ level: "error", path: "", line: 0, message: `actionlint could not run: ${r.error.message}` }];
  const out = r.stdout.trim();
  if (r.status !== 0 && !out.startsWith("[")) {
    return [{ level: "error", path: "", line: 0, message: `actionlint failed: ${r.stderr || out}` }];
  }
  const errors = out ? (JSON.parse(out) as ActionlintError[] | null) ?? [] : [];
  return errors.map((e) => ({ level: "error", path: e.filepath, line: e.line, message: `actionlint [${e.kind}]: ${e.message}` }));
}

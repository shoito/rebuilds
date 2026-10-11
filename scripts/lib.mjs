// Shared helpers for the document checks (ADR-0009).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Tracked and untracked (not ignored) files, relative to the repo root.
export function listFiles(patterns) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...patterns], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean).filter((f) => !f.startsWith('.claude/'));
}

export function read(file) {
  return readFileSync(path.join(root, file), 'utf8');
}

export function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(
    m[1].split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]),
  );
}

// ADR files are NNNN-slug.md inside a decisions/ directory.
export const ADR_FILE = /(^|\/)decisions\/(\d{4})-[^/]+\.md$/;

export function adrTitle(text) {
  const m = text.match(/^# ADR-(\d{4}):\s*(.+)$/m);
  return m ? { number: m[1], title: m[2].trim() } : null;
}

// 1-based line number of a character offset.
export function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

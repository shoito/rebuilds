// Regenerate the generated parts of docs/open-decisions.md: proposed ADRs and legal open items per subject.
// Usage: node scripts/open-decisions.mjs [--check]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADR_FILE, adrTitle, frontmatter, listFiles, read, root } from './lib.mjs';

const FILE = 'docs/open-decisions.md';

function replaceBlock(text, name, body) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < 0) return text;
  return `${text.slice(0, s + start.length)}\n${body}\n${text.slice(e)}`;
}

// "systems/<name>/docs/decisions/..." -> "<name>", "docs/decisions/..." -> "リポジトリ共通"
const scopeOf = (f) => (f.startsWith('systems/') ? f.split('/')[1] : 'リポジトリ共通');

function proposedAdrs(files) {
  const all = files
    .filter((f) => ADR_FILE.test(f))
    .map((f) => ({ f, text: read(f) }))
    .map(({ f, text }) => ({ f, text, fm: frontmatter(text) }))
    .filter(({ fm }) => fm.status === 'proposed')
    .map(({ f, text, fm }) => {
      const t = adrTitle(text);
      const link = `[ADR-${t?.number ?? '????'}](${path.relative('docs', f)})`;
      return { now: !fm.decide_after, row: [scopeOf(f), link, t?.title ?? '', fm.decide_after ?? fm.date ?? ''] };
    })
    .sort((a, b) => a.row.join('|').localeCompare(b.row.join('|')));
  const table = (head, rows) =>
    [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  const now = all.filter((x) => x.now).map((x) => x.row);
  const later = all.filter((x) => !x.now).map((x) => x.row);
  return [
    '**今判断が要るもの**',
    '',
    table(['題材', 'ADR', '決定', '起票日'], now),
    '',
    '**判断する時点を待つもの**（frontmatter の `decide_after`）',
    '',
    table(['題材', 'ADR', '決定', '判断する時点'], later),
  ].join('\n');
}

// Legal items are the rows "| L<n> | …" in each subject's intent.md.
function legalCounts(files) {
  const rows = files
    .filter((f) => /^systems\/[^/]+\/docs\/intent\.md$/.test(f))
    .sort()
    .map((f) => {
      const n = (read(f).match(/^\|\s*L\d+\s*\|/gm) ?? []).length;
      return `| ${scopeOf(f)} | ${n || '表の形でない（intent を見る）'} | [intent.md](${path.relative('docs', f)}) |`;
    });
  return ['| 題材 | 法務の確認待ち（L 番号の数） | 置き場所 |', '| --- | --- | --- |', ...rows].join('\n');
}

export function openDecisionsProblems({ fix = false } = {}) {
  const files = listFiles(['*.md']);
  if (!files.includes(FILE)) return [];
  const text = read(FILE);
  let next = replaceBlock(text, 'proposed-adrs', proposedAdrs(files));
  next = replaceBlock(next, 'legal-counts', legalCounts(files));
  if (next === text) return [];
  if (fix) {
    writeFileSync(path.join(root, FILE), next);
    return [];
  }
  return [`${FILE}: generated tables are out of date (run: npm run open-decisions)`];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = openDecisionsProblems({ fix: !process.argv.includes('--check') });
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}

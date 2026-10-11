// Regenerate the ADR tables in decisions/README.md from each ADR's frontmatter and title.
// Usage: node scripts/adr-index.mjs [--check]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ADR_FILE, adrTitle, frontmatter, listFiles, read, root } from './lib.mjs';

const START = '<!-- adr-index:start -->';
const END = '<!-- adr-index:end -->';

export function adrIndexProblems({ fix = false } = {}) {
  const problems = [];
  const files = listFiles(['*.md']);
  const byDir = new Map();
  for (const f of files) {
    if (!ADR_FILE.test(f)) continue;
    const dir = path.dirname(f);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(f);
  }
  for (const [dir, adrs] of byDir) {
    const readme = `${dir}/README.md`;
    if (!files.includes(readme)) continue;
    const text = read(readme);
    const s = text.indexOf(START);
    const e = text.indexOf(END);
    if (s < 0 || e < 0) continue;
    const rows = adrs.sort().map((f) => {
      const body = read(f);
      const t = adrTitle(body);
      const status = frontmatter(body).status ?? '';
      return `| [${t?.number ?? '????'}](${path.basename(f)}) | ${t?.title ?? ''} | ${status} |`;
    });
    const table = ['| ADR | 決定 | 状態 |', '| --- | --- | --- |', ...rows].join('\n');
    const next = `${text.slice(0, s + START.length)}\n${table}\n${text.slice(e)}`;
    if (next !== text) {
      if (fix) writeFileSync(path.join(root, readme), next);
      else problems.push(`${readme}: ADR index is out of date (run: npm run adr-index)`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes('--check');
  const problems = adrIndexProblems({ fix: !check });
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}

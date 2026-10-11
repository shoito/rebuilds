// Quantitative scan of every subject for the design-review skill.
// Prints Markdown tables so two runs can be compared.
// Usage: node .claude/skills/design-review/scripts/scan.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const systems = path.join(root, 'systems');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : [],
  );
}

// Generic runbooks every subject has; anything else is subject-specific.
const GENERIC_RUNBOOKS = new Set(['README.md', 'deploy-and-rollback.md', 'disaster-recovery.md', 'incident-response.md']);
const README_SECTIONS = {
  ctx: /^### .*コンテキスト/m,
  container: /^### .*コンテナ/m,
  flows: /^### .*主要な(流れ|フロー)|^## .*主要フロー/m,
  original: /^### .*本家の形/m,
  cost: /^### .*費用/m,
  areas: /^## .*領域の文書/m,
};
const CONCERNS = {
  a11y: /アクセシビリティ|WCAG/,
  i18n: /多言語|i18n|ICU MessageFormat|国際化/,
  migration: /移行の取り込み|本家からの移行|インポート|取り込み（移行）/,
  export: /書き出し/,
  operator: /運用者の(本番への)?アクセス|JIT/,
  legal: /法務の確認待ち/,
};
const DIAGRAMS = ['stateDiagram', 'sequenceDiagram', 'flowchart', 'gantt', 'erDiagram'];

const rows = [];
for (const name of readdirSync(systems).sort()) {
  const docs = path.join(systems, name, 'docs');
  if (!existsSync(docs)) continue;
  const files = walk(docs);
  const texts = files.map((f) => readFileSync(f, 'utf8'));
  const all = texts.join('\n');
  const readmePath = path.join(docs, 'architecture/README.md');
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  const kinds = Object.fromEntries(DIAGRAMS.map((k) => [k, 0]));
  for (const m of all.matchAll(/```mermaid\n\s*(\S+)/g)) {
    const k = DIAGRAMS.find((d) => m[1].startsWith(d)) ?? (m[1].startsWith('graph') ? 'flowchart' : null);
    if (k) kinds[k]++;
  }
  const decisions = path.join(docs, 'decisions');
  const runbooks = path.join(docs, 'runbooks');
  rows.push({
    name,
    md: files.length,
    lines: texts.reduce((n, t) => n + t.split('\n').length, 0),
    readme: readme.split('\n').length,
    adr: existsSync(decisions) ? readdirSync(decisions).filter((f) => /^\d{4}-/.test(f)).length : 0,
    ...kinds,
    sections: Object.fromEntries(Object.entries(README_SECTIONS).map(([k, re]) => [k, re.test(readme)])),
    runbooks: existsSync(runbooks) ? readdirSync(runbooks).filter((f) => !GENERIC_RUNBOOKS.has(f)).length : 0,
    concerns: Object.fromEntries(
      Object.entries(CONCERNS).map(([k, re]) => [k, files.filter((_, i) => re.test(texts[i])).length]),
    ),
    designLog: existsSync(path.join(docs, 'architecture/design-log.md')),
  });
}

const table = (head, body) =>
  [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const mark = (b) => (b ? '○' : '×');

console.log('## 規模と図\n');
console.log(table(
  ['題材', 'md', '行', 'README の行', 'ADR', 'state', 'sequence', 'flow', 'gantt', 'ER', '固有の runbook'],
  rows.map((r) => [r.name, r.md, r.lines, r.readme, r.adr, r.stateDiagram, r.sequenceDiagram, r.flowchart, r.gantt, r.erDiagram, r.runbooks]),
));
console.log('\n## architecture/README.md の節（docs/templates/architecture.md との差）\n');
console.log(table(
  ['題材', ...Object.keys(README_SECTIONS), 'design-log'],
  rows.map((r) => [r.name, ...Object.values(r.sections).map(mark), mark(r.designLog)]),
));
console.log('\n## 観点の言及（言及のあるファイルの数。0 は漏れの候補で、grep で中身を確かめる）\n');
console.log(table(['題材', ...Object.keys(CONCERNS)], rows.map((r) => [r.name, ...Object.values(r.concerns)])));

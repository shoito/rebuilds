// Document checks for rebuilds (ADR-0009). Prints "file:line: message" and exits 1 on problems.
// Usage:
//   node scripts/check.mjs                 # all files, all checks
//   node scripts/check.mjs --no-mermaid    # skip the browser-based Mermaid check
//   node scripts/check.mjs --files a.md b.html
import { existsSync } from 'node:fs';
import path from 'node:path';
import { adrIndexProblems } from './adr-index.mjs';
import { ADR_FILE, adrTitle, frontmatter, lineOf, listFiles, read, root } from './lib.mjs';

const args = process.argv.slice(2);
const noMermaid = args.includes('--no-mermaid');
const fi = args.indexOf('--files');
const only = fi >= 0 ? args.slice(fi + 1).map((f) => path.relative(root, path.resolve(f))) : null;

const all = listFiles(['*.md', '*.html']);
const targets = only ? all.filter((f) => only.includes(f)) : all;
const md = targets.filter((f) => f.endsWith('.md'));
const html = targets.filter((f) => f.endsWith('.html'));
const problems = [];

// Links in templates resolve where the template is copied to, not where it lives.
const isTemplate = (f) => f.startsWith('docs/templates/');
const stripCode = (t) => t.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '));

// 1. Relative links in Markdown.
for (const f of md) {
  if (isTemplate(f)) continue;
  const text = stripCode(read(f));
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) continue;
    const target = decodeURI(href.split('#')[0]);
    if (target && !existsSync(path.join(root, path.dirname(f), target))) {
      problems.push(`${f}:${lineOf(text, m.index)}: broken link ${href}`);
    }
  }
}

// 2. ADRs: duplicate numbers, number matches file name, title length for new ADRs (process.md §9).
const TITLE_RULE_FROM = '2026-10-11';
const TITLE_MAX = 60;
const seen = new Map();
for (const f of all.filter((x) => ADR_FILE.test(x))) {
  const num = f.match(ADR_FILE)[2];
  const key = `${path.dirname(f)}/${num}`;
  if (seen.has(key)) problems.push(`${f}:1: duplicate ADR number ${num} (also ${seen.get(key)})`);
  seen.set(key, f);
  if (!targets.includes(f)) continue;
  const text = read(f);
  const t = adrTitle(text);
  if (!t) {
    problems.push(`${f}:1: missing "# ADR-NNNN: <title>" heading`);
    continue;
  }
  if (t.number !== num) problems.push(`${f}:1: heading says ADR-${t.number} but file is ${num}`);
  const date = frontmatter(text).date ?? '';
  if (date >= TITLE_RULE_FROM && [...t.title].length > TITLE_MAX) {
    problems.push(`${f}:1: ADR title is ${[...t.title].length} chars (max ${TITLE_MAX}, process.md §9)`);
  }
}

// 3. ADR indexes are generated from the ADRs.
if (!only || md.some((f) => ADR_FILE.test(f) || f.endsWith('decisions/README.md'))) {
  problems.push(...adrIndexProblems());
}

// 4. Published HTML: GA tag, favicon, site name (AGENTS.md, docs/primer/AUTHORING.md).
for (const f of html) {
  const text = read(f);
  if (!text.includes("gtag('config', 'G-LRH3HT8NDH')")) problems.push(`${f}:1: missing Google Analytics tag G-LRH3HT8NDH`);
  if (!/<link rel="icon" href="[^"]*favicon\.svg"/.test(text)) problems.push(`${f}:1: missing favicon link`);
  if (!text.includes('<meta property="og:site_name" content="rebuilds">')) problems.push(`${f}:1: missing og:site_name`);
  if (/^systems\/[^/]+\/docs\/primer\/index\.html$/.test(f) && !text.includes('<section class="s" id="learn">')) {
    problems.push(`${f}:1: missing the「この題材から学べること」section (id="learn", docs/primer/AUTHORING.md)`);
  }
}

// 5. Wording rules that can be checked mechanically (AGENTS.md「言語」).
for (const f of [...md, ...html]) {
  const text = read(f);
  for (const m of text.matchAll(/状態機械|状態の機械/g)) {
    // Lines that state the rule itself mention both words.
    const line = text.split('\n')[lineOf(text, m.index) - 1];
    if (line.includes('ステートマシン')) continue;
    problems.push(`${f}:${lineOf(text, m.index)}: write「ステートマシン」, not「${m[0]}」`);
  }
}

// 6. Mermaid syntax (Markdown fences and <pre class="mermaid"> in HTML).
// Loaded lazily so the other checks still run before `npm ci` has installed Mermaid.
if (!noMermaid) {
  const { mermaidProblems } = await import('./mermaid.mjs');
  problems.push(...(await mermaidProblems([...md, ...html])));
}

for (const p of problems) console.error(p);
console.error(problems.length ? `\n${problems.length} problem(s)` : `ok: ${targets.length} file(s) checked`);
process.exit(problems.length ? 1 : 0);

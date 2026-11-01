// Generates site pages from the documents (ADR-0009). Usage: node scripts/pages.mjs
//   docs/patterns/index.html  from docs/patterns.md
//   docs/agents/index.html    from docs/agents.md
//   docs/glossary/index.html  from every primer's <dl class="glossary">
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { listFiles, read, root } from './lib.mjs';

const SITE = 'https://shoito.github.io/rebuilds/';
const REPO = 'https://github.com/shoito/rebuilds/';

const MD_PAGES = [
  {
    src: 'docs/patterns.md',
    out: 'docs/patterns/index.html',
    description: '同じ設計の問題が、どの題材のどの文書に出てくるかをテーマごとにまとめた索引。',
  },
  {
    src: 'docs/agents.md',
    out: 'docs/agents/index.html',
    description: '21 の題材が、AI エージェントを主な作り手にする問いにどう答えたかをまとめた索引。',
  },
];
const GLOSSARY_OUT = 'docs/glossary/index.html';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const rel = (from, to) => path.posix.relative(path.posix.dirname(from), to) || './';
const pageUrl = (out) => SITE + out.replace(/index\.html$/, '');

// Rewrite one href in a Markdown source so it works on the published page `out`.
function rewriteHref(href, src, out) {
  if (href.startsWith(SITE)) return rel(out, href.slice(SITE.length) || 'index.html');
  if (/^([a-z]+:|#)/i.test(href)) return href;
  const [p, hash] = href.split('#');
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(src), decodeURI(p)));
  const anchor = hash ? `#${hash}` : '';
  const page = MD_PAGES.find((x) => x.src === target);
  if (page) return rel(out, page.out) + anchor;
  if (target.endsWith('.html')) return rel(out, target) + anchor;
  const abs = path.join(root, target);
  const kind = existsSync(abs) && statSync(abs).isDirectory() ? 'tree' : 'blob';
  return `${REPO}${kind}/main/${target.replace(/\/$/, '')}${anchor}`;
}

function shell({ out, title, description, body, script = '' }) {
  const back = path.posix.relative(path.posix.dirname(out), '.');
  const up = back ? `${back}/` : '';
  const home = `${up}index.html`;
  return `<!doctype html>
<html lang="ja">
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LRH3HT8NDH"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-LRH3HT8NDH');
</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | rebuilds</title>
<meta property="og:site_name" content="rebuilds">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)} | rebuilds">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${pageUrl(out)}">
<meta property="og:image" content="${SITE}docs/primer/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="description" content="${esc(description)}">
<link rel="icon" href="${up}docs/primer/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${up}docs/primer/assets/primer.css">
<style>
  main.page { margin: 0 auto; padding: 24px 16px 64px; max-width: 980px; }
  .page .hero { margin-bottom: 24px; }
  .page .source { color: var(--muted); font-size: .85em; margin: .6em 0 0; }
  .page h2 { font-size: 1.3em; margin: 1.8em 0 .7em; padding-bottom: .35em; border-bottom: 2px solid var(--accent); color: var(--accent-strong); }
  /* Keep cells readable on phones; the table scrolls sideways instead (primer.css). */
  .page table th, .page table td { min-width: 9em; overflow-wrap: break-word; }
</style>
</head>
<body>
<header class="bar">
  <a class="home" href="${home}">← <span>題材の一覧</span></a>
  <div class="title">${esc(title)}</div>
</header>
<main class="page">
${body}
</main>
${script}</body>
</html>
`;
}

const MERMAID = `<script type="module">
  const blocks = document.querySelectorAll('pre.mermaid');
  if (blocks.length) {
    const mermaid = (await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs')).default;
    mermaid.initialize({ startOnLoad: false, theme: 'base', fontFamily: getComputedStyle(document.body).fontFamily });
    await mermaid.run({ nodes: blocks });
  }
</script>
`;

function markdownPage({ src, out, description }) {
  const text = read(src);
  const m = text.match(/^# (.+)\n/);
  if (!m) throw new Error(`${src}: missing "# " heading`);
  const title = m[1].trim();
  const marked = new Marked({
    gfm: true,
    walkTokens(t) {
      if (t.type === 'link') t.href = rewriteHref(t.href, src, out);
    },
    renderer: {
      code({ text: code, lang }) {
        if (lang === 'mermaid') return `<pre class="mermaid">${esc(code)}</pre>\n`;
        return false;
      },
    },
  });
  const content = marked.parse(text.slice(m[0].length));
  const body = `<header class="hero">
  <h1>${esc(title)}</h1>
  <p class="source">このページは <a href="${REPO}blob/main/${src}">${src}</a> から生成しています。</p>
</header>
${content.trim()}`;
  return shell({ out, title, description, body, script: /<pre class="mermaid">/.test(content) ? MERMAID : '' });
}

// Glossary entries of every primer: [{ term, key, entries: [{ subject, href, dd }] }]
function glossaryGroups(out) {
  const primers = listFiles(['docs/primer/index.html', 'systems/*/docs/primer/index.html']).sort();
  const DISPLAY_NAMES = { mercari: 'メルカリ', 'google-calendar': 'Google カレンダー' };
  const groups = new Map();
  const subjects = new Set();
  for (const f of primers) {
    const html = read(f);
    const t = html.match(/<title>(.+?) \| rebuilds<\/title>/);
    const id = (f.match(/^systems\/([^/]+)\//) || [])[1];
    // Use the display names of the top page where they differ from the page titles.
    const subject = f.startsWith('docs/') ? '共通' : (DISPLAY_NAMES[id] ?? t[1].replace(/ の前提知識$/, ''));
    for (const dl of html.matchAll(/<dl class="glossary">([\s\S]*?)<\/dl>/g)) {
      const ids = (dl[1].match(/<dt id="g-/g) || []).length;
      const items = [...dl[1].matchAll(/<dt id="(g-[^"]+)"[^>]*>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)];
      if (items.length !== ids) throw new Error(`${f}: a <dt id="g-…"> is not followed by <dd>`);
      for (const [, id, dt, dd] of items) {
        const term = dt.replace(/<[^>]+>/g, '').trim();
        const key = term.normalize('NFKC');
        if (!groups.has(key)) groups.set(key, { term, key, entries: [] });
        // Links inside a definition point into its own primer; keep their text only.
        const def = dd.replace(/<\/?a\b[^>]*>/g, '').trim();
        groups.get(key).entries.push({ subject, href: `${rel(out, f)}#${id}`, def });
        subjects.add(subject);
      }
    }
  }
  const collator = new Intl.Collator('ja', { sensitivity: 'base', numeric: true });
  const list = [...groups.values()].sort((a, b) => collator.compare(a.key, b.key) || (a.key < b.key ? -1 : 1));
  for (const g of list) g.entries.sort((a, b) => (a.subject === '共通' ? -1 : b.subject === '共通' ? 1 : collator.compare(a.subject, b.subject)));
  return { list, subjects: subjects.size, sources: primers.length };
}

function glossaryPage() {
  const out = GLOSSARY_OUT;
  const { list, subjects } = glossaryGroups(out);
  const title = '用語の索引';
  const description = '前提知識の資料の用語集を、題材をまたいで 1 つにまとめた索引。';
  const rows = list
    .map((g) => {
      const items = g.entries
        .map((e) => `<li><a class="subj" href="${e.href}">${esc(e.subject)}</a><span class="def">${e.def}</span></li>`)
        .join('');
      return `<div class="entry"><div class="term">${esc(g.term)}</div><ul>${items}</ul></div>`;
    })
    .join('\n');
  const body = `<style>
  .filter { position: sticky; top: 56px; z-index: 10; background: var(--bg); padding: 8px 0 10px; border-bottom: 1px solid var(--border); margin-bottom: 8px; }
  .filter input { width: 100%; font: inherit; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); }
  .filter input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .filter .count { color: var(--muted); font-size: .85em; margin: 4px 0 0; }
  .entry { display: grid; grid-template-columns: minmax(8em, 14em) minmax(0, 1fr); gap: 4px 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
  .entry .term { font-weight: 700; color: var(--accent-strong); }
  .entry ul { list-style: none; margin: 0; padding: 0; }
  .entry li + li { margin-top: .4em; }
  .entry .subj { display: inline-block; min-width: 7em; margin-right: .6em; font-size: .85em; font-weight: 700; }
  .entry .def { color: var(--muted); }
  @media (max-width: 560px) { .entry { grid-template-columns: minmax(0, 1fr); } .entry .subj { display: block; min-width: 0; } }
</style>
<header class="hero">
  <h1>${title}</h1>
  <p class="lead">前提知識の資料の用語集を、題材をまたいで 1 つにまとめました。同じ用語は 1 行にまとめ、題材ごとの説明と、資料の用語集へのリンクを並べています。</p>
  <p class="source">このページは、共通の前提知識と各題材の資料（<code>docs/primer/index.html</code>、<code>systems/*/docs/primer/index.html</code>）の用語集から生成しています。</p>
</header>
<div class="filter">
  <input id="q" type="search" placeholder="用語や説明で絞り込む" aria-label="用語や説明で絞り込む" autocomplete="off">
  <p class="count" id="count" aria-live="polite">${list.length} 語（${subjects} の資料：共通の前提知識と ${subjects - 1} 題材）</p>
</div>
<div id="list">
${rows}
</div>`;
  const script = `<script>
  (() => {
    const norm = (s) => s.normalize('NFKC').toLowerCase();
    const rows = Array.from(document.querySelectorAll('#list .entry')).map((el) => ({ el, text: norm(el.textContent) }));
    const q = document.getElementById('q');
    const count = document.getElementById('count');
    const total = count.textContent;
    q.addEventListener('input', () => {
      const v = norm(q.value.trim());
      let n = 0;
      for (const r of rows) { const hit = !v || r.text.includes(v); r.el.hidden = !hit; if (hit) n++; }
      count.textContent = v ? n + ' 語が一致（全 ' + rows.length + ' 語）' : total;
    });
  })();
</script>
`;
  return shell({ out, title, description, body, script });
}

export function pages() {
  return [...MD_PAGES.map((p) => [p.out, markdownPage(p)]), [GLOSSARY_OUT, glossaryPage()]];
}

export function glossaryStats() {
  const { list, subjects } = glossaryGroups(GLOSSARY_OUT);
  return { terms: list.length, entries: list.reduce((n, g) => n + g.entries.length, 0), subjects };
}

export function pagesProblems() {
  return pages()
    .filter(([out, html]) => !existsSync(path.join(root, out)) || readFileSync(path.join(root, out), 'utf8') !== html)
    .map(([out]) => `${out}:1: out of date with its source; run \`npm run pages\``);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [out, html] of pages()) {
    mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
    writeFileSync(path.join(root, out), html);
    console.error(`wrote ${out}`);
  }
  const s = glossaryStats();
  console.error(`glossary: ${s.terms} terms, ${s.entries} entries, ${s.subjects} sources`);
}

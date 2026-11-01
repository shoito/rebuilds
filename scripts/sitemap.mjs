// Generates sitemap.xml from the published HTML pages (ADR-0009). Usage: node scripts/sitemap.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { listFiles, root } from './lib.mjs';

const SITE = 'https://shoito.github.io/rebuilds/';
const FILE = 'sitemap.xml';

export function sitemapXml() {
  const pages = listFiles(['*.html'])
    .filter((f) => f !== '404.html')
    .map((f) => SITE + f.replace(/(^|\/)index\.html$/, '$1'))
    .sort();
  const urls = pages.map((u) => `  <url><loc>${u}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function sitemapProblems() {
  const file = path.join(root, FILE);
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return current === sitemapXml() ? [] : [`${FILE}:1: out of date with the published pages; run \`npm run sitemap\``];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(path.join(root, FILE), sitemapXml());
  console.error(`wrote ${FILE}`);
}

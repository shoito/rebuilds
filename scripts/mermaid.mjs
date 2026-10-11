// Parse every Mermaid diagram in one headless Chrome page.
// Chrome is taken from CHROME_PATH or the usual install locations (GitHub's Ubuntu runners have it).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import puppeteer from 'puppeteer-core';
import { lineOf, read } from './lib.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function extract(files) {
  const blocks = [];
  for (const f of files) {
    const text = read(f);
    const re = f.endsWith('.html') ? /<pre class="mermaid">([\s\S]*?)<\/pre>/g : /```mermaid\n([\s\S]*?)```/g;
    for (const m of text.matchAll(re)) {
      blocks.push({ where: `${f}:${lineOf(text, m.index)}`, src: f.endsWith('.html') ? unescapeHtml(m[1]) : m[1] });
    }
  }
  return blocks;
}

export async function mermaidProblems(files) {
  const blocks = extract(files);
  if (!blocks.length) return [];
  const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) return ['mermaid: Chrome not found (set CHROME_PATH, or pass --no-mermaid)'];
  const mermaidJs = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js');
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ path: mermaidJs });
    const errors = await page.evaluate(async (srcs) => {
      window.mermaid.initialize({ startOnLoad: false });
      const out = [];
      for (const [i, src] of srcs.entries()) {
        try {
          await window.mermaid.parse(src);
        } catch (e) {
          out.push([i, String(e?.message ?? e).split('\n').slice(0, 3).join(' ')]);
        }
      }
      return out;
    }, blocks.map((b) => b.src));
    return errors.map(([i, msg]) => `${blocks[i].where}: mermaid: ${msg}`);
  } finally {
    await browser.close();
  }
}

// Claude Code hook entry for the document checks (ADR-0009). Wired in .claude/settings.json.
//   post: after Edit/Write, check the edited .md/.html file.
//   stop: before the agent stops, check every changed .md/.html file.
// Exit 2 sends the problems back to the agent; anything else never blocks.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './lib.mjs';

const mode = process.argv[2];
const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const isDoc = (f) => /\.(md|html)$/.test(f) && !f.startsWith('.claude/') && !f.startsWith('node_modules/');

let files = [];
if (mode === 'post') {
  const f = input.tool_input?.file_path ?? input.tool_response?.filePath;
  if (f) files = [path.relative(root, path.resolve(f))];
} else if (mode === 'stop') {
  if (input.stop_hook_active) process.exit(0); // already sent back once; do not loop
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).split('\n');
  files = [...git('diff', '--name-only', 'HEAD'), ...git('ls-files', '--others', '--exclude-standard')];
}
files = [...new Set(files)].filter((f) => f && !f.startsWith('..') && isDoc(f) && existsSync(path.join(root, f)));
if (!files.length) process.exit(0);

const args = ['scripts/check.mjs', '--files', ...files];
if (!existsSync(path.join(root, 'node_modules/mermaid'))) args.splice(1, 0, '--no-mermaid');
const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
if (r.status === 0) process.exit(0);
process.stderr.write(`Document checks failed (npm run check, ADR-0009):\n${r.stderr}`);
process.exit(2);

import { readFileSync } from 'node:fs';
import frames from './codex-pane/v0.147.0.json';

const path = Bun.argv[2];
if (!path) throw new Error('fixture state path required');
let previous = '';
setInterval(() => {
  const state = readFileSync(path, 'utf8');
  if (state !== 'menu' && state !== 'idle') throw new Error('unknown fixture state');
  if (state === previous) return;
  previous = state;
  process.stdout.write(`\x1b[2J\x1b[H${frames[state].replaceAll('\n', '\r\n')}`);
}, 20);

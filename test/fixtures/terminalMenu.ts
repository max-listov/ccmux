import { appendFileSync, readFileSync } from 'node:fs';

const [statePath, logPath] = Bun.argv.slice(2);
if (!statePath || !logPath) throw new Error('fixture paths required');
process.stdin.setRawMode(true);
process.stdin.resume();
let selected = 0;
let state = '';
function draw() {
  process.stdout.write('\x1b[2J\x1b[H');
  if (state === 'menu')
    process.stdout.write(
      [
        'Allow external imports?',
        `${selected === 0 ? '❯' : ' '} No, disable external imports`,
        `${selected === 1 ? '❯' : ' '} Yes, allow`,
        'Enter to confirm · Esc to cancel',
      ].join('\r\n'),
    );
  else process.stdout.write('Composer ready\r\n❯ ');
}
process.stdin.on('data', (chunk: Buffer) => {
  appendFileSync(logPath, `${JSON.stringify(chunk.toString())}\n`);
  if (state !== 'menu') return;
  if (chunk.toString() === '\x1b[B' || chunk.toString() === '\x1bOB') selected = 1;
  if (chunk.toString() === '\x1b[A' || chunk.toString() === '\x1bOA') selected = 0;
  if (chunk.includes(13)) state = 'submitted';
  draw();
});
setInterval(() => {
  const next = readFileSync(statePath, 'utf8');
  if (next !== state && state !== 'submitted') {
    state = next;
    draw();
  }
}, 10);

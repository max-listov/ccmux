import { expect, test } from 'bun:test';
import { join } from 'node:path';

// A caller that stops reading leaves a pipe that fails the first write with EPIPE and never drains
// again. A writer that waited for `drain` there waited forever while the runtime retried the queued
// bytes: `ccmux fleet` whose caller had finished spun a core for hours.
const writer = `
import { printLine } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'util', 'stdout.ts'))};
await Bun.sleep(300);
const answers = [];
for (let i = 0; i < 5; i++) answers.push(await printLine('line ' + i + ' ' + 'x'.repeat(200)));
console.error(JSON.stringify(answers));
`;

test('a writer whose reader has left finishes instead of waiting for a drain that never comes', async () => {
  const started = Date.now();
  const child = Bun.spawn(['sh', '-c', `"${process.execPath}" -e "$WRITER" | true`], {
    env: { ...process.env, WRITER: writer },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const exited = await Promise.race([child.exited, Bun.sleep(10_000).then(() => 'hung' as const)]);
  if (exited === 'hung') child.kill('SIGKILL');
  expect(exited).toBe(0);
  expect(Date.now() - started).toBeLessThan(10_000);
  // The first write may still reach the pipe's buffer; after the reader is gone, every later one
  // reports it.
  const answers = JSON.parse((await new Response(child.stderr).text()).trim()) as boolean[];
  expect(answers.at(-1)).toBe(false);
});

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeJournalPath } from '../src/runtime/journal.ts';
import { openOwnedRuntimeJournal } from '../src/runtime/journalOwner.ts';
import { makeMachine } from './helpers.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test('owned journal recovers only after its real prior process died and retains frames', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ccmux-journal-owner-'));
  roots.push(stateDir);
  const m = makeMachine({ stateDir });
  const script = `import { openOwnedRuntimeJournal } from ${JSON.stringify(resolve('src/runtime/journalOwner.ts'))};
    const j=await openOwnedRuntimeJournal(JSON.parse(process.argv[1]),{kind:'daemon'});
    j.submit({at:new Date().toISOString(),runtime:'daemon',kind:'started'});
    await new Promise(resolve=>setTimeout(resolve,30));
    console.log('READY'); await new Promise(()=>{});`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '-e', script, JSON.stringify(m)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // A bounded positive handshake, not absence of output as evidence of readiness.
  const reader = child.stdout.getReader();
  let ready = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    while (!ready.includes('READY')) {
      const next = await reader.read();
      if (next.done) throw new Error('Journal child exited early');
      ready += new TextDecoder().decode(next.value);
    }
    clearTimeout(timer);
    child.kill('SIGKILL');
    await child.exited;
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await child.exited;
    reader.releaseLock();
  }
  const journal = await openOwnedRuntimeJournal(m, { kind: 'daemon' });
  expect(journal.recovered).toBe(true);
  journal.submit({ at: new Date().toISOString(), runtime: 'daemon', kind: 'recovery' });
  await journal.close();
  const path = runtimeJournalPath(m, { kind: 'daemon' });
  const frames = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(frames.map((frame) => frame.event.kind)).toEqual(['started', 'recovery']);
  expect(JSON.parse(await readFile(`${path}.status.json`, 'utf8')).state).toBe('closed');
});

import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readDiagnosticJournalLockDiagnosis } from 'stitchkit/application';
import { type RuntimeJournalWriter, runtimeJournalPath } from '../src/runtime/journal.ts';
import { openOwnedRuntimeJournal } from '../src/runtime/journalOwner.ts';
import type { MachineConfig } from '../src/types.ts';
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

type Holder = { pid: number; writer: RuntimeJournalWriter; stop: () => Promise<void> };
/** A real process that opens `writer`'s journal and keeps it, so its lock records a real identity. */
async function holdJournal(m: MachineConfig, writer: RuntimeJournalWriter): Promise<Holder> {
  const script = `import { openOwnedRuntimeJournal } from ${JSON.stringify(resolve('src/runtime/journalOwner.ts'))};
    await openOwnedRuntimeJournal(JSON.parse(process.argv[1]),JSON.parse(process.argv[2]));
    console.log('READY'); await new Promise(()=>{});`;
  const child = Bun.spawn(
    [process.execPath, '--no-env-file', '-e', script, JSON.stringify(m), JSON.stringify(writer)],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let out = '';
  try {
    while (!out.includes('READY')) {
      const next = await reader.read();
      if (next.done) throw new Error('Journal holder exited early');
      out += new TextDecoder().decode(next.value);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return {
    pid: child.pid,
    writer,
    stop: async () => {
      child.kill('SIGKILL');
      await child.exited;
    },
  };
}
const readLock = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

// A crash reboot hands the dead writer's pid to an unrelated process. The lock record carries the
// owner's boot and birth, so only the writer itself — same boot, same birth — keeps the journal.
test('a crash-left journal lock whose pid now belongs to another process is reclaimed', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'ccmux-journal-reuse-'));
  roots.push(stateDir);
  const m = makeMachine({ stateDir });
  const path = runtimeJournalPath(m, { kind: 'daemon' });
  const dead = await holdJournal(m, { kind: 'daemon' });
  await dead.stop();
  const deadOwner = await readLock(`${path}.lock`);
  const live = await holdJournal(m, { kind: 'worker', registration: crypto.randomUUID() });
  try {
    const liveOwner = await readLock(`${runtimeJournalPath(m, live.writer)}.lock`);
    expect(liveOwner.process).not.toBeNull();
    expect(deadOwner.process.startId).not.toBe(liveOwner.process.startId);

    const forge = async (process: unknown) => {
      const record = { ...deadOwner, pid: live.pid, process };
      await writeFile(`${path}.lock`, JSON.stringify(record));
      await writeFile(`${path}.owner-lock`, JSON.stringify(record));
    };
    for (const process of [
      { ...liveOwner.process, bootId: 'another-boot' },
      { ...liveOwner.process, startId: deadOwner.process.startId },
    ]) {
      await forge(process);
      const journal = await openOwnedRuntimeJournal(m, { kind: 'daemon' });
      expect(journal.recovered).toBe(true);
      await journal.close();
    }

    // Negative control: the recorded owner IS the live process — same boot, same birth.
    await writeFile(`${path}.lock`, JSON.stringify({ ...liveOwner }));
    const refused = await openOwnedRuntimeJournal(m, { kind: 'daemon' }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(readDiagnosticJournalLockDiagnosis(refused)?.identity).toBe('matched');
  } finally {
    await live.stop();
  }
});

import { afterEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticJournalFrameSchema } from 'stitchkit/application';
import {
  createRuntimeJournal,
  RUNTIME_JOURNAL_LIMITS,
  RuntimeJournalEventSchema,
  runtimeJournalPath,
} from '../src/runtime/journal.ts';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const stateDir = await mkdtemp(join(tmpdir(), 'ccmux-runtime-journal-'));
  roots.push(stateDir);
  return { stateDir };
}
const event = () =>
  RuntimeJournalEventSchema.parse({
    at: new Date().toISOString(),
    kind: 'started',
    runtime: 'custom',
  });

test('runtime journal rejects non-allowlisted payloads before persistence', async () => {
  const m = await fixture();
  const journal = await createRuntimeJournal(m, { kind: 'daemon' }, () => undefined);
  try {
    const secret = 'secret-like-fixture-not-for-journal';
    const invalid = { ...event(), prompt: secret };
    expect(journal.submit(invalid)).toEqual({ outcome: 'refused', reason: 'invalid' });
    expect(journal.submit(event()).outcome).toBe('accepted');
    expect((await journal.flush({ timeoutMs: 1000 })).outcome).toBe('settled');
    const path = runtimeJournalPath(m, { kind: 'daemon' });
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(secret);
    expect(journal.getStatus()).toMatchObject({ accepted: 1, refused: 1, written: 1 });
    const frames = text
      .trim()
      .split('\n')
      .map((line) => DiagnosticJournalFrameSchema.parse(JSON.parse(line)));
    expect(frames).toHaveLength(1);
    expect(RuntimeJournalEventSchema.parse(frames[0]?.event).kind).toBe('started');
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await journal.close({ timeoutMs: 1000 });
  }
});

test('runtime journals separate writers and expose bounded admission pressure', async () => {
  const m = await fixture();
  const daemon = await createRuntimeJournal(m, { kind: 'daemon' }, () => undefined);
  const worker = await createRuntimeJournal(
    m,
    {
      kind: 'worker',
      registration: crypto.randomUUID(),
    },
    () => undefined,
  );
  try {
    await expect(createRuntimeJournal(m, { kind: 'daemon' }, () => undefined)).rejects.toThrow();
    for (let i = 0; i < RUNTIME_JOURNAL_LIMITS.maxPendingItems + 32; i++) daemon.submit(event());
    expect(daemon.getStatus().pendingItems).toBeLessThanOrEqual(
      RUNTIME_JOURNAL_LIMITS.maxPendingItems,
    );
    expect(daemon.getStatus().pendingBytes).toBeLessThanOrEqual(
      RUNTIME_JOURNAL_LIMITS.maxPendingBytes,
    );
    expect(daemon.getStatus().refusals['item-capacity']).toBeGreaterThan(0);
    expect(worker.submit(event()).outcome).toBe('accepted');
    expect((await daemon.close({ timeoutMs: 1000 })).outcome).toBe('closed');
    expect(daemon.submit(event())).toEqual({ outcome: 'refused', reason: 'closed' });
    expect(worker.submit(event()).outcome).toBe('accepted');
  } finally {
    await daemon.close({ timeoutMs: 1000 });
    await worker.close({ timeoutMs: 1000 });
  }
});

test('runtime journal reports a partial tail and refuses an unproven stale writer lock', async () => {
  const m = await fixture();
  const first = await createRuntimeJournal(m, { kind: 'daemon' }, () => undefined);
  await first.close();
  const path = runtimeJournalPath(m, { kind: 'daemon' });
  await writeFile(path, '{partial-fixture', { mode: 0o600 });
  const second = await createRuntimeJournal(m, { kind: 'daemon' }, () => undefined);
  expect(second.getStatus()).toMatchObject({ partialTails: 1, rotations: 1, retainedFiles: 2 });
  await second.close();
  await writeFile(`${path}.lock`, '', { mode: 0o600 });
  await expect(createRuntimeJournal(m, { kind: 'daemon' }, () => undefined)).rejects.toThrow();
  expect(await readFile(`${path}.1`, 'utf8')).toBe('{partial-fixture');
});

test('runtime journal rotation, cancellation and failed rotation remain observable', async () => {
  const m = await fixture();
  const path = runtimeJournalPath(m, { kind: 'daemon' });
  const first = await createRuntimeJournal(m, { kind: 'daemon' }, () => undefined);
  first.submit(event());
  await first.close();
  const frame = await readFile(path, 'utf8');
  // Valid complete frames fill the existing generation; the next accepted event must rotate it.
  await writeFile(
    path,
    frame.repeat(Math.ceil(RUNTIME_JOURNAL_LIMITS.maxFileBytes / Buffer.byteLength(frame))),
  );
  const failures: unknown[] = [];
  const next = await createRuntimeJournal(m, { kind: 'daemon' }, (failure) => {
    failures.push(failure);
  });
  try {
    next.submit(event());
    expect((await next.flush({ timeoutMs: 1000 })).outcome).toBe('settled');
    expect(next.getStatus().rotations).toBeGreaterThanOrEqual(1);
    expect(next.getStatus().retainedFiles).toBeLessThanOrEqual(RUNTIME_JOURNAL_LIMITS.maxFiles);
    const abort = new AbortController();
    for (let n = 0; n < 128; n++) next.submit(event());
    abort.abort();
    expect((await next.flush({ signal: abort.signal })).outcome).toBe('cancelled');
    expect((await next.close({ timeoutMs: 2000 })).outcome).toBe('closed');
    expect(failures).toEqual([]);
  } finally {
    await next.close();
  }

  // Startup succeeded; a later conflicting generation causes a real storage failure, not a mock.
  await writeFile(
    path,
    frame.repeat(Math.floor(RUNTIME_JOURNAL_LIMITS.maxFileBytes / Buffer.byteLength(frame)) - 1),
  );
  const broken = await createRuntimeJournal(m, { kind: 'daemon' }, (failure) => {
    failures.push(failure);
  });
  await mkdir(`${path}.${RUNTIME_JOURNAL_LIMITS.maxFiles - 1}`);
  try {
    for (let n = 0; n < 8; n++) broken.submit(event());
    expect((await broken.flush({ timeoutMs: 1000 })).state).toBe('failed');
    expect(broken.getStatus().rotationFailures).toBe(1);
    expect(broken.submit(event())).toEqual({ outcome: 'refused', reason: 'failed' });
    expect(failures).toHaveLength(1);
    expect((await broken.close({ timeoutMs: 1000 })).state).toBe('failed');
  } finally {
    await broken.close();
  }
});

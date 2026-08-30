import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readLifecycleBlockForSession,
  writeLifecycleBlock,
} from '../src/config/lifecycleBlocks.ts';
import {
  loadPendingSessions,
  promotePendingSession,
  removePendingSession,
  reservePendingSession,
} from '../src/config/pendingSessions.ts';
import { loadPendingRows, writePendingRows } from '../src/config/pendingStore.ts';
import { PendingSessionSchema, SessionSchema } from '../src/config/schema.ts';
import { promotedPending } from '../src/config/sessionRegistry.ts';
import { loadReadyRows, writeReadyRows } from '../src/config/sessionStore.ts';
import {
  appendSession,
  loadSessions,
  removeSession,
  removeSessionIfGeneration,
} from '../src/config/sessions.ts';
import { makeMachine } from './helpers.ts';

const GENERATION = '11111111-1111-4111-8111-111111111111';
const READY = '22222222-2222-4222-8222-222222222222';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-codex-state-'));
  const stateDir = join(root, 'state');
  mkdirSync(stateDir);
  return makeMachine({ stateDir });
}

function pending(name = 'agent-a') {
  return PendingSessionSchema.parse({
    generation: GENERATION,
    marker: `ccmux_${GENERATION}`,
    operation: { kind: 'create' },
    session: { name, dir: '/home/user', agent: 'codex' },
    createdAt: '2026-08-10T00:00:00.000Z',
    status: 'pending',
  });
}

test('pending launch is separate from the ready registry and promotes exact identity', async () => {
  const m = setup();
  await reservePendingSession(m, pending());
  expect(loadSessions(m)).toEqual([]);
  expect(loadPendingSessions(m)).toHaveLength(1);
  const ready = await promotePendingSession(m, GENERATION, READY);
  expect(ready.uuid).toBe(READY);
  expect(ready.agent).toBe('codex');
  expect(ready.registrationGeneration).toBe(GENERATION);
  expect(loadSessions(m)).toEqual([ready]);
  expect(loadPendingSessions(m)).toEqual([]);
});

test('late rollback removes only the row promoted by its own generation', async () => {
  const m = setup();
  await reservePendingSession(m, pending());
  await promotePendingSession(m, GENERATION, READY);
  expect(await removeSessionIfGeneration(m, 'agent-a', GENERATION)).toBe(true);

  const replacement = SessionSchema.parse({
    name: 'agent-a',
    dir: '/home/user',
    agent: 'codex',
    uuid: READY,
  });
  await appendSession(m, replacement);
  expect(await removeSessionIfGeneration(m, 'agent-a', GENERATION)).toBe(false);
  expect(loadSessions(m)).toEqual([replacement]);
  expect(await removeSession(m, 'agent-a')).toBe(true);
});

test('late promotion cannot overwrite a removed generation', async () => {
  const m = setup();
  await reservePendingSession(m, pending());
  await removePendingSession(m, GENERATION);
  await expect(promotePendingSession(m, GENERATION, READY)).rejects.toThrow(
    'removed, replaced, or blocked',
  );
  expect(loadSessions(m)).toEqual([]);
});

test('promotion rejects a claimed UUID and preserves unrelated registry rows', async () => {
  const m = setup();
  const existing = SessionSchema.parse({
    name: 'agent-b',
    dir: '/home/user',
    agent: 'claude',
    uuid: READY,
  });
  await appendSession(m, existing);
  await reservePendingSession(m, pending());
  await expect(promotePendingSession(m, GENERATION, READY)).rejects.toThrow('already claimed');
  expect(loadSessions(m)).toEqual([existing]);
  expect(loadPendingSessions(m)).toHaveLength(1);
});

test('a pending Codex name atomically reserves against a ready Claude append', async () => {
  const m = setup();
  await reservePendingSession(m, pending());
  const claude = SessionSchema.parse({
    name: 'agent-a',
    dir: '/home/user',
    agent: 'claude',
    uuid: READY,
  });
  await expect(appendSession(m, claude)).rejects.toThrow('pending create transaction');
  expect(loadSessions(m)).toEqual([]);
  expect(loadPendingSessions(m)).toHaveLength(1);
});

test('promoted journal is a ready read view and the next mutation completes recovery', async () => {
  const m = setup();
  const journal = promotedPending(pending(), READY);
  await writePendingRows(m, [journal]);
  expect(loadReadyRows(m)).toEqual([]);
  expect(loadSessions(m)[0]).toMatchObject({
    name: 'agent-a',
    uuid: READY,
    registrationGeneration: GENERATION,
  });

  const unrelated = SessionSchema.parse({
    name: 'agent-b',
    dir: '/home/user',
    agent: 'claude',
    uuid: '33333333-3333-4333-8333-333333333333',
  });
  await appendSession(m, unrelated);
  expect(loadPendingRows(m)).toEqual([]);
  expect(loadReadyRows(m).map((session) => session.name)).toEqual(['agent-a', 'agent-b']);
});

test('journal-first read view returns one ready identity at every promotion boundary', async () => {
  const m = setup();
  const journal = promotedPending(pending(), READY);
  const ready = SessionSchema.parse({
    ...journal.session,
    uuid: READY,
    registrationGeneration: GENERATION,
  });

  await writePendingRows(m, [journal]);
  expect(loadSessions(m)).toEqual([ready]);
  await writeReadyRows(m, [ready]);
  expect(loadSessions(m)).toEqual([ready]);
  await writePendingRows(m, []);
  expect(loadSessions(m)).toEqual([ready]);
});

test('a stale lifecycle block cannot poison a same-name replacement', async () => {
  const m = setup();
  const replacement = SessionSchema.parse({
    name: 'agent-a',
    dir: '/home/user',
    agent: 'codex',
    uuid: READY,
    registrationGeneration: '33333333-3333-4333-8333-333333333333',
  });
  await appendSession(m, replacement);
  await writeLifecycleBlock(m, {
    name: 'agent-a',
    agent: 'codex',
    uuid: READY,
    generation: GENERATION,
    error: 'old transaction failed',
    at: '2026-08-10T00:00:00.000Z',
  });
  expect(readLifecycleBlockForSession(m, replacement)).toBeNull();

  await writeLifecycleBlock(m, {
    name: 'agent-a',
    agent: 'codex',
    uuid: READY,
    generation: replacement.registrationGeneration,
    error: 'current transaction failed',
    at: '2026-08-10T00:00:00.000Z',
  });
  expect(readLifecycleBlockForSession(m, replacement)?.error).toBe('current transaction failed');
});

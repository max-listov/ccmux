import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { managedPeer } from '../src/chat/identity.ts';
import type { CreateManagedInput } from '../src/commands/create.ts';
import { loadSessions, writeSessionsUnlocked } from '../src/config/sessions.ts';
import { archiveControlSession, createControlSession } from '../src/control/lifecycle.ts';
import { makeMachine, makeSession } from './helpers.ts';

test('control create request is durable and idempotent across a lost reply', async () => {
  const stateDir = mkdtempSync('/tmp/ccmux-control-lifecycle-');
  const workspace = mkdtempSync('/tmp/ccmux-control-workspace-');
  const m = makeMachine({ stateDir, rcPrefix: 'host-a' });
  const requestId = crypto.randomUUID();
  let calls = 0;
  const create = async (_machine: typeof m, input: CreateManagedInput) => {
    calls++;
    await Bun.sleep(10);
    const session = makeSession({
      name: input.name,
      dir: input.dir,
      uuid: crypto.randomUUID(),
      agent: 'codex',
      runtime: 'app-server',
      registrationGeneration: input.registrationGeneration,
      chatEnabled: true,
    });
    await writeSessionsUnlocked(m, [session]);
    return session;
  };
  const [first, duplicate] = await Promise.all([
    createControlSession(
      m,
      { requestId, name: 'worker', workspace, flags: [] },
      new AbortController().signal,
      create,
    ),
    createControlSession(
      m,
      { requestId, name: 'worker', workspace, flags: [] },
      new AbortController().signal,
      create,
    ),
  ]);
  expect(calls).toBe(1);
  expect(first.target).toEqual(duplicate.target);
  expect([first.duplicate, duplicate.duplicate].sort()).toEqual([false, true]);
  expect(loadSessions(m)).toHaveLength(1);
  await expect(
    createControlSession(
      m,
      { requestId, name: 'other', workspace, flags: [] },
      new AbortController().signal,
      create,
    ),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

  const secondState = makeMachine({ ...m, stateDir: mkdtempSync('/tmp/ccmux-control-lost-') });
  const lostId = crypto.randomUUID();
  const lost = async (_machine: typeof m, input: CreateManagedInput) => {
    const session = makeSession({
      name: input.name,
      dir: input.dir,
      uuid: crypto.randomUUID(),
      agent: 'codex',
      runtime: 'app-server',
      registrationGeneration: input.registrationGeneration,
    });
    await writeSessionsUnlocked(secondState, [session]);
    throw new Error('reply lost after promotion');
  };
  const reconciled = await createControlSession(
    secondState,
    { requestId: lostId, name: 'lost', workspace, flags: [] },
    new AbortController().signal,
    lost,
  );
  const registered = loadSessions(secondState)[0];
  assert(registered);
  expect(reconciled.target.threadId).toBe(registered.uuid);
});

test('archive is exact, idempotent and keeps the canonical registry identity', async () => {
  const tmuxBin = Bun.which('tmux');
  assert(tmuxBin, 'tmux must be installed for lifecycle tests');
  const m = makeMachine({
    stateDir: mkdtempSync('/tmp/ccmux-control-archive-'),
    rcPrefix: 'host-a',
    tmuxBin,
  });
  const session = makeSession({
    name: `test-${crypto.randomUUID()}`,
    agent: 'codex',
    runtime: 'app-server',
  });
  await writeSessionsUnlocked(m, [session]);
  const target = managedPeer(m.rcPrefix, session);
  expect(await archiveControlSession(m, target)).toMatchObject({
    archived: true,
    duplicate: false,
    stopped: false,
  });
  expect(loadSessions(m)[0]).toMatchObject({ uuid: session.uuid, archived: true });
  expect(await archiveControlSession(m, target)).toMatchObject({
    archived: true,
    duplicate: true,
    stopped: false,
  });
  await expect(
    archiveControlSession(m, { ...target, threadId: crypto.randomUUID() }),
  ).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
});

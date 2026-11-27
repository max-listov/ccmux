import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { managedPeer } from '../src/chat/identity.ts';
import { writeSessionsUnlocked } from '../src/session/registry.ts';
import { idleProof } from '../src/session/sleep/proof.ts';
import { type SleepRecord, SleepRecordSchema } from '../src/session/sleep/schema.ts';
import { showsAsSleeping, writeSleep } from '../src/session/sleep/store.ts';
import type { MachineConfig, Session } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/stitchmux-sleep-display-'));
  roots.push(root);
  const m = makeMachine({ stateDir: join(root, 'state'), rcPrefix: 'host-a' });
  const s = makeSession({
    name: 'agent-a',
    agent: 'claude',
    dir: root,
    registrationGeneration: crypto.randomUUID(),
  });
  return { m, s };
}

function record(m: MachineConfig, s: Session, phase: SleepRecord['phase']): SleepRecord {
  const now = new Date().toISOString();
  const target = managedPeer(m.rcPrefix, s);
  return SleepRecordSchema.parse({
    target,
    registrationGeneration: s.registrationGeneration,
    operationId: crypto.randomUUID(),
    phase,
    updatedAt: now,
    proof: {
      target,
      registrationGeneration: s.registrationGeneration,
      revision: 'a'.repeat(64),
      generation: null,
      eligible: true,
      run: 'idle',
      queue: 0,
      approvals: 0,
      children: 0,
      background: 0,
      reason: null,
      observedAt: now,
      processes: [],
    },
  });
}

test('a session shows as sleeping while its sleep is requested or done, never while waking', async () => {
  const { m, s } = fixture();
  expect(showsAsSleeping(m, s, false)).toBe(false);
  for (const [phase, expected] of [
    ['requested', true],
    ['sleeping', true],
    ['waking', false],
    ['awake', false],
  ] as const) {
    await writeSleep(m, s, record(m, s, phase));
    expect([phase, showsAsSleeping(m, s, false)]).toEqual([phase, expected]);
    expect([phase, showsAsSleeping(m, s, null)]).toEqual([phase, expected]);
  }
});

test('a running or archived session never shows as sleeping', async () => {
  const { m, s } = fixture();
  await writeSleep(m, s, record(m, s, 'sleeping'));
  expect(showsAsSleeping(m, s, true)).toBe(false);
  expect(showsAsSleeping(m, { ...s, archived: true }, false)).toBe(false);
});

test('a terminal session whose panes tmux cannot list reports approvals as unknown, not zero', async () => {
  const { m, s } = fixture();
  await writeSessionsUnlocked(m, [s]);
  const tmuxBin = Bun.which('tmux');
  if (tmuxBin === null) throw Error('tmux is required');
  const noServer = { ...m, tmuxBin, tmuxSocket: `stitchmux-display-none-${process.pid}` };
  expect(await idleProof(noServer, s)).toMatchObject({
    eligible: false,
    reason: 'owner-unavailable',
    approvals: null,
  });
});

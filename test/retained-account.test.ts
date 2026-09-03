import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { managedRuntimeRoot, readManagedRuntimeStatus } from '../src/runtime/status.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * Which account a session runs on does not stop being true when the process dies.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ACCOUNT = {
  label: 'someone@example.test',
  organization: 'personal',
  subscription: 'Claude Max',
  provider: 'firstParty',
};

function fixture(observedMsAgo: number) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ccmux-retained-'));
  roots.push(stateDir);
  const m = makeMachine({ stateDir });
  const session = makeSession({
    name: 'agent-A',
    agent: 'claude',
    runtime: 'native',
    registrationGeneration: '11111111-1111-4111-8111-111111111111',
    nativeSession: {
      runtime: 'claude',
      id: '22222222-2222-4222-8222-222222222222',
      version: '2.0.0',
    },
  });
  const root = managedRuntimeRoot(m, session);
  mkdirSync(root, { recursive: true });
  const now = Date.now();
  writeFileSync(
    join(root, 'status.json'),
    JSON.stringify({
      protocol: 1,
      provider: 'claude',
      machine: m.rcPrefix,
      session: session.name,
      threadId: session.uuid,
      generation: '33333333-3333-4333-8333-333333333333',
      registrationGeneration: session.registrationGeneration,
      nativeSession: session.nativeSession,
      sequence: 1,
      pid: process.pid,
      providerPid: process.pid,
      version: '2.0.0',
      connected: true,
      state: 'idle',
      reason: null,
      observedAt: new Date(now - observedMsAgo).toISOString(),
      expiresAt: new Date(now - observedMsAgo + 1_000).toISOString(),
      turn: null,
      events: [],
      pendingRequests: [],
      account: ACCOUNT,
    }),
    { mode: 0o600 },
  );
  return { m, session, now };
}

test('a runtime whose lease expired keeps naming its account', () => {
  // The state must go — a stale projection answering "idle" would be a lie. The account is not
  // that kind of fact, and dropping it with everything else made the row vanish from `accounts`
  // while the person was still signed in, which a plan bar reads as "no plan" rather than
  // "not running".
  const { m, session, now } = fixture(60_000);
  const read = readManagedRuntimeStatus(m, session, now);
  expect(read.status).not.toBe('live');
  expect(read.snapshot).toBeNull();
  expect(read.retained?.account?.label).toBe(ACCOUNT.label);
});

test('a live runtime answers from its snapshot and retains nothing separately', () => {
  const { m, session, now } = fixture(0);
  const read = readManagedRuntimeStatus(m, session, now);
  expect(read.status).toBe('live');
  expect(read.snapshot?.account?.label).toBe(ACCOUNT.label);
  expect(read.retained).toBeNull();
});

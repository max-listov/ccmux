import { afterAll, expect, test } from 'bun:test';
import { clearWaiting, readWaiting, writeWaiting } from '../src/agent/sessionStatus.ts';
import { RemoteSessionSchema } from '../src/commands/fleetList.ts';

/**
 * A session standing on `ccmux wait` is mid-turn and therefore reads as working — which is true at
 * the wrong altitude. It is the one edge a "who is holding whom" chain can be built from, so it is
 * declared rather than guessed at from a command line.
 */

const names: string[] = [];
afterAll(() => {
  for (const name of names.splice(0)) clearWaiting(name);
});
const declare = async (over: Partial<Parameters<typeof writeWaiting>[1]> = {}) => {
  const name = `agent-${Math.random().toString(36).slice(2, 8)}`;
  names.push(name);
  await writeWaiting(name, {
    target: 'host-B:agent-B',
    since: Date.now(),
    pid: process.pid,
    expiresAt: Date.now() + 3_000,
    ...over,
  });
  return name;
};

test('a live wait names who it waits for', async () => {
  const name = await declare();
  expect(readWaiting(name)?.target).toBe('host-B:agent-B');
});

test('a record whose writer was killed outright reads as no wait at all', async () => {
  // `wait` is routinely SIGKILLed by a fleet restart sweep — it is built to survive exactly that —
  // so no exit handler runs. Clearing on the way out is the fast path; this is the mechanism.
  // A pid that cannot exist stands in for the process that is gone.
  const name = await declare({ pid: 2 ** 30 });
  expect(readWaiting(name)).toBeNull();
});

test('a record nobody refreshed stops meaning anything', async () => {
  const name = await declare({ expiresAt: Date.now() - 1 });
  // A stale wait is worse than an absent one: it reads as a fact, and this project has already
  // measured that failure in lifecycle stamps left behind by turns that were killed.
  expect(readWaiting(name)).toBeNull();
});

test('clearing removes it without waiting for the deadline', async () => {
  const name = await declare();
  clearWaiting(name);
  expect(readWaiting(name)).toBeNull();
});

test('a peer too old to report the field does not fail the parse of its row', () => {
  const row = RemoteSessionSchema.parse({ name: 'agent-A', state: 'working' });
  // Null here is "that build does not say", never "that session waits for nobody" — the same
  // distinction already drawn for turnStartedAt beside it. Without the default, one un-upgraded
  // peer would take every row in the fleet down with it.
  expect(row.waitingFor).toBeNull();
  expect(
    RemoteSessionSchema.parse({ name: 'agent-A', waitingFor: 'host-B:agent-B' }).waitingFor,
  ).toBe('host-B:agent-B');
});

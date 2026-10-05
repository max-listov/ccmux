import { expect, test } from 'bun:test';
import { ensureOnce } from '../src/session/heal.ts';
import { parsePaneInventory } from '../src/tmux/paneInventory.ts';
import type { Session } from '../src/types.ts';
import { makeSession } from './helpers.ts';

const keepPin = (s: Session): Promise<Session> => Promise.resolve(s);
const agentGone = new Set<string>();
const retire = (): Promise<void> => Promise.resolve();

test('ensureOnce starts only down, non-archived sessions; re-reads each call', () => {
  let sessionList = [
    makeSession({ name: 'cc-a' }),
    makeSession({ name: 'cc-b' }),
    makeSession({ name: 'cc-arch', archived: true }),
  ];
  const started: string[] = [];
  let reads = 0;

  const deps = {
    sessions: () => {
      reads += 1;
      return sessionList;
    },
    // reflects reality: cc-a is up, and anything we start becomes running
    observe: () => Promise.resolve({ live: new Set<string>(['cc-a', ...started]), agentGone }),
    retire,
    followFork: keepPin,
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  };

  return ensureOnce(deps).then(() => {
    expect(started).toEqual(['cc-b']); // cc-a running, cc-arch archived → only cc-b
    expect(reads).toBe(1);
    // a fresh session added externally is picked up next call — proves no caching
    sessionList = [...sessionList, makeSession({ name: 'cc-new' })];
    return ensureOnce(deps).then(() => {
      expect(started).toEqual(['cc-b', 'cc-new']);
    });
  });
});

test('ensureOnce is a no-op when everything is running', async () => {
  const started: string[] = [];
  await ensureOnce({
    sessions: () => [makeSession({ name: 'cc-a' })],
    observe: () => Promise.resolve({ live: new Set(['cc-a']), agentGone }),
    retire,
    followFork: keepPin,
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  });
  expect(started).toEqual([]);
});

test('ensureOnce follows forks on EVERY pass (running sessions too), before the start decision', async () => {
  const followed: string[] = [];
  const started: string[] = [];
  await ensureOnce({
    sessions: () => [
      makeSession({ name: 'cc-up' }),
      makeSession({ name: 'cc-down' }),
      makeSession({ name: 'cc-arch', archived: true }),
    ],
    observe: () => Promise.resolve({ live: new Set(['cc-up']), agentGone }),
    retire,
    followFork: (s) => {
      followed.push(s.name);
      return Promise.resolve(s);
    },
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  });
  // running sessions are re-pinned too (their NEXT restart must resume the fork);
  // archived stay untouched; the down session is started only after its fork check
  expect(followed).toEqual(['cc-up', 'cc-down']);
  expect(started).toEqual(['cc-down']);
});

test('a session whose agent pane died while another window kept it alive is taken down and started', async () => {
  const events: string[] = [];
  await ensureOnce({
    sessions: () => [
      makeSession({ name: 'cc-a' }),
      makeSession({ name: 'cc-arch', archived: true }),
    ],
    observe: () =>
      Promise.resolve({ live: new Set<string>(), agentGone: new Set(['cc-a', 'cc-arch']) }),
    retire: (name) => {
      events.push(`retire ${name}`);
      return Promise.resolve();
    },
    followFork: keepPin,
    start: (name) => {
      events.push(`start ${name}`);
      return Promise.resolve();
    },
  });
  // Taken down before it is started (starting a session tmux still has would fail); an archived one
  // is not healed, so it is not touched either.
  expect(events).toEqual(['retire cc-a', 'start cc-a']);
});

test('a session whose rows tmux reported unreadably is neither taken down nor started', async () => {
  // agent-a: the agent pane's row is unreadable (bad created stamp), the auxiliary pane's row is
  // fine. Read alone, the accepted row says "the agent's pane is gone" — and healing kills that.
  // agent-b: its only row is unreadable, so it is in no set at all and would be "started" each pass.
  const inventory = parsePaneInventory(
    [
      'agent-a|%1|%1|bad',
      'agent-a|%2|%1|1700000000',
      'agent-b|%3|%3|bad',
      'agent-c|%4|%4|1700000000',
    ].join('\n'),
  );
  expect(inventory.agentGone.has('agent-a')).toBe(false);
  const retired: string[] = [];
  const started: string[] = [];
  await ensureOnce({
    sessions: () => ['agent-a', 'agent-b', 'agent-c'].map((name) => makeSession({ name })),
    observe: () => Promise.resolve(inventory),
    retire: (name: string) => {
      retired.push(name);
      return Promise.resolve();
    },
    followFork: keepPin,
    start: (name: string) => {
      started.push(name);
      return Promise.resolve();
    },
  });
  expect(retired).toEqual([]);
  expect(started).toEqual([]);
});

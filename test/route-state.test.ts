import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { fallbackIsNew, routeRecovered } from '../src/fleet/routeState.ts';
import { makeMachine } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function machine() {
  const root = mkdtempSync('/tmp/ccmux-route-state-');
  roots.push(root);
  return makeMachine({ stateDir: root, rcPrefix: 'host-a' });
}

test('a held fallback is news once, a changed reason is news again, and so is coming back', async () => {
  // Twelve thousand identical lines in a week on one machine: a fan-out poller times every peer,
  // and "the remote route is down" was written once per call. It is a level, not an event.
  const m = machine();
  expect(await fallbackIsNew(m, 'host-b', 'private transport unavailable')).toBe(true);
  expect(await fallbackIsNew(m, 'host-b', 'private transport unavailable')).toBe(false);
  expect(await fallbackIsNew(m, 'host-b', 'private transport unavailable')).toBe(false);

  // A different reason is a different condition, and the reader needs to see it.
  expect(await fallbackIsNew(m, 'host-b', 'local remote adapter is unavailable')).toBe(true);

  // Peers are independent: one route being down says nothing about another.
  expect(await fallbackIsNew(m, 'host-c', 'private transport unavailable')).toBe(true);
  expect(await fallbackIsNew(m, 'host-b', 'local remote adapter is unavailable')).toBe(false);

  // Recovery is news exactly once — and the log never said it at all before.
  expect(await routeRecovered(m, 'host-b')).toBe(true);
  expect(await routeRecovered(m, 'host-b')).toBe(false);
  // A peer that was never seen falling back has not recovered from anything.
  expect(await routeRecovered(m, 'host-d')).toBe(false);
  // And after recovery, the next outage is news again.
  expect(await fallbackIsNew(m, 'host-b', 'private transport unavailable')).toBe(true);
});

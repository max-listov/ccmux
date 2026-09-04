import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { ExternalStatusObserver } from '../src/external/resident-observer.ts';
import { ExternalStatusPublisher } from '../src/external/resident-publisher.ts';
import { makeMachine } from './helpers.ts';

/**
 * The generation is a boundary a consumer may cross only once, and it costs it something.
 *
 * By contract every generation it is shown must be retired: old numbering cannot be compared past
 * it, and the retired set is bounded. So minting one is spending a consumer's resource, and it was
 * being spent on an event that had not happened — a connection ATTEMPT, not a connection. On a
 * machine whose provider is absent the reconciliation tick attempted, failed, and minted, over and
 * over: measured by a consumer at seven generations in twelve seconds with zero external sessions
 * and an unbroken sequence, which is the contradiction — one producer numbering continuously while
 * announcing that its numbering had restarted seven times. Their bound of 128 arrived in four
 * minutes, the stream was dropped and rebuilt, all day.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function absentProvider() {
  const root = mkdtempSync('/tmp/ccmux-external-generation-');
  roots.push(root);
  const machine = makeMachine({ stateDir: root, codexHome: root, rcPrefix: 'host-a' });
  const publisher = new ExternalStatusPublisher('host-a');
  let attempts = 0;
  const observer = new ExternalStatusObserver(machine, publisher, () => {
    attempts++;
    return Promise.reject(new Error('no provider on this machine'));
  });
  return { machine, publisher, observer, attempts: () => attempts };
}

test('a machine with no provider keeps one generation however often it tries', async () => {
  const f = absentProvider();
  const first = f.publisher.read();
  const sequences: number[] = [];
  for (let tick = 0; tick < 8; tick++) {
    await f.observer.refresh();
    sequences.push(f.publisher.read().sequence);
  }
  const after = f.publisher.read();
  // Eight attempts were really made — this is not a case that passes by doing nothing.
  expect(f.attempts()).toBe(8);
  expect(after.generation).toBe(first.generation);
  expect(after.status).toBe('unavailable');
  // And the stream does not repeat itself: the same refusal, said once. Without this the sequence
  // advanced on every tick and woke every reader with a snapshot identical to the previous one —
  // a stream at its busiest when there is nothing at all to report.
  expect(new Set(sequences).size).toBe(1);
}, 30_000);

test('a refusal that changes is still published at once', async () => {
  const f = absentProvider();
  await f.observer.refresh();
  const pending = f.publisher.read();
  f.publisher.unavailable('config-changed');
  const changed = f.publisher.read();
  // Suppression is about repetition, never about news: a different reason reaches the consumer on
  // the snapshot that carries it.
  expect(changed.reason).toBe('config-changed');
  expect(changed.sequence).toBeGreaterThan(pending.sequence);
  expect(changed.generation).toBe(pending.generation);
});

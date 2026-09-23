import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { loadAckedIds, loadAcks } from '../src/chat/ackLog.ts';
import { buildEnvelope } from '../src/chat/compose.ts';
import { loadCursors } from '../src/chat/cursors.ts';
import { chatTargetKey, cliPrincipal, managedPeer } from '../src/chat/identity.ts';
import { appendMessage, loadLedger } from '../src/chat/ledger.ts';
import { deliverableTargets, pendingConditional, pendingImmediate } from '../src/chat/store.ts';
import { settleUndeliverable } from '../src/chat/undeliverable.ts';
import { sessionsPath } from '../src/config/paths.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync('/tmp/ccmux-undeliverable-');
  roots.push(root);
  const machine = makeMachine({ stateDir: root, rcPrefix: 'host-a', chatEnabled: true });
  const live = makeSession({ name: 'alive', dir: root, chat: true, uuid: crypto.randomUUID() });
  writeFileSync(sessionsPath(machine), `${JSON.stringify(live)}\n`);
  // Removed from the registry, which is what "the session no longer exists" IS: delivery walks that
  // file, so nothing addressed to this peer is ever looked at again.
  const gone = managedPeer('host-a', makeSession({ name: 'gone', uuid: crypto.randomUUID() }));
  const from = cliPrincipal('host-a');
  const write = (to: ReturnType<typeof managedPeer>, body: string, defer: boolean) => {
    const envelope = buildEnvelope(from, to, body, { defer, task: 'orphans' });
    appendMessage(machine, envelope);
    return envelope;
  };
  return { machine, root, gone, alive: managedPeer('host-a', live), write };
}

test('letters to a session that no longer exists are settled on BOTH tracks, once', async () => {
  const f = fixture();
  const waiting = f.write(f.gone, 'deferred to a ghost', true);
  const immediate = f.write(f.gone, 'immediate to a ghost', false);
  const keep = f.write(f.alive, 'for a session that is still here', true);
  const live = deliverableTargets(f.machine);
  expect(live.has(chatTargetKey(f.gone))).toBe(false);

  expect(await settleUndeliverable(f.machine)).toBe(2);

  const ledger = loadLedger(f.machine);
  const acked = loadAcks(f.machine);
  const cursors = loadCursors(f.machine);
  // Nothing addressed to the removed session is waiting any more — and the two halves had to be
  // closed differently, because a conditional letter is settled by the ack log and an immediate one
  // only by the recipient's delivery cursor.
  expect(pendingConditional(ledger, acked, {}).map((m) => m.id)).toEqual([keep.id]);
  expect(pendingImmediate(ledger, cursors, {}).map((m) => m.id)).toEqual([]);
  expect(loadAcks(f.machine).get(waiting.id)).toBe('undeliverable');
  expect(loadAcks(f.machine).has(immediate.id)).toBe(false);
  // The letters themselves are kept: the ledger is append-only, and what ended is the waiting.
  expect(ledger.filter((slot) => slot !== null)).toHaveLength(3);

  // Idempotent: a pass over an already-settled queue writes nothing and reports nothing.
  expect(await settleUndeliverable(f.machine)).toBe(0);
  expect(loadAckedIds(f.machine).size).toBe(1);
});

test('a letter to a session that still exists is never settled by this pass', async () => {
  const f = fixture();
  const keep = f.write(f.alive, 'still owed an answer', true);
  const soon = f.write(f.alive, 'on its way', false);
  expect(await settleUndeliverable(f.machine)).toBe(0);
  expect(loadAckedIds(f.machine).size).toBe(0);
  expect(
    pendingConditional(loadLedger(f.machine), loadAcks(f.machine), {}).map((m) => m.id),
  ).toEqual([keep.id]);
  expect(
    pendingImmediate(loadLedger(f.machine), loadCursors(f.machine), {}).map((m) => m.id),
  ).toEqual([soon.id]);
});

test('an unchanged queue costs nothing to re-examine, and neither kind of change is missed', async () => {
  // The pass runs on the daemon's event loop every three seconds. Measured on a 5 MB ledger it
  // cost 40-270 ms to settle nothing, so an unchanged queue now stops at two `stat` calls — and
  // the only thing that must never happen is a change slipping through that skip.
  const f = fixture();
  f.write(f.gone, 'first orphan', true);
  expect(await settleUndeliverable(f.machine)).toBe(1);
  expect(await settleUndeliverable(f.machine)).toBe(0);

  // A new letter grows the ledger.
  const late = f.write(f.gone, 'written after the sweep', true);
  expect(await settleUndeliverable(f.machine)).toBe(1);
  expect(loadAcks(f.machine).get(late.id)).toBe('undeliverable');

  // A removal rewrites the registry, and it strands letters that were fine a moment ago.
  const orphaned = f.write(f.alive, 'fine until its recipient was removed', true);
  expect(await settleUndeliverable(f.machine)).toBe(0);
  writeFileSync(sessionsPath(f.machine), '');
  expect(await settleUndeliverable(f.machine)).toBe(1);
  expect(loadAcks(f.machine).get(orphaned.id)).toBe('undeliverable');
});

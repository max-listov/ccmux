import { expect, test } from 'bun:test';
import { buildEnvelope } from '../src/chat/compose.ts';
import { managedPeer, ownerTarget } from '../src/chat/identity.ts';
import { conditionalMessage } from '../src/chat/pendingDelivery.ts';
import { makeMachine, makeSession } from './helpers.ts';

/**
 * When a letter is allowed to land.
 *
 * Typed input reaches a working Claude session as steering — it goes INTO the running turn and
 * redirects it — so an agent's routine message cut across work nobody asked it to interrupt. The
 * sender cannot judge from outside whether that is warranted, so it does not get to: the recipient's
 * own turn boundary is the default arrival time, and breaking in is the thing that must be asked for.
 */

const m = makeMachine({ rcPrefix: 'host-a' });
const to = managedPeer(m.rcPrefix, makeSession({ name: 'agent-a' }));
const from = managedPeer(m.rcPrefix, makeSession({ name: 'agent-b' }));

test('an ordinary message waits for the boundary without being asked to', () => {
  const envelope = buildEnvelope(from, to, 'status update');
  expect(envelope.defer).toBe(true);
  // Off the in-order cursor, so a letter waiting on one busy recipient never blocks another's.
  expect(conditionalMessage(envelope)).toBe(true);
});

test('breaking into a running turn is the thing that has to be asked for', () => {
  expect(buildEnvelope(from, to, 'stop, wrong branch', { defer: false }).defer).toBe(false);
});

test('the owner has no turn to wait for', () => {
  // Deferring here would hold a letter for a boundary that never comes.
  expect(buildEnvelope(from, ownerTarget(), 'ready', { defer: false }).defer).toBe(false);
});

test('letters that waited out one turn arrive as one turn', async () => {
  const { coalesce } = await import('../src/chat/deliver.ts');
  const { managedPeerKey } = await import('../src/chat/identity.ts');
  // Two peers writing to a busy session used to cost it two turns, and the second landed INSIDE the
  // turn the first had just started — the recipient interrupted by its own mail.
  const ledger = [
    buildEnvelope(from, to, 'first'),
    buildEnvelope(from, to, 'second'),
    buildEnvelope(from, managedPeer(m.rcPrefix, makeSession({ name: 'agent-c' })), 'not yours'),
  ];
  const batch = coalesce(ledger, managedPeerKey(to), new Set(), Date.now());
  expect(batch.map((msg) => msg.body)).toEqual(['first', 'second']);
  // One already handed over is not handed over again.
  expect(
    coalesce(ledger, managedPeerKey(to), new Set([ledger[0]?.id as string]), Date.now()).map(
      (msg) => msg.body,
    ),
  ).toEqual(['second']);
});

test('a timer that is not due yet does not ride along with mail that is', async () => {
  const { coalesce } = await import('../src/chat/deliver.ts');
  const { managedPeerKey } = await import('../src/chat/identity.ts');
  const soon = new Date(Date.now() + 60_000).toISOString();
  const ledger = [
    buildEnvelope(from, to, 'now'),
    buildEnvelope(from, to, 'later', { notBefore: soon }),
  ];
  expect(coalesce(ledger, managedPeerKey(to), new Set(), Date.now()).map((m2) => m2.body)).toEqual([
    'now',
  ]);
});

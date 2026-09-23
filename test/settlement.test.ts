import { expect, test } from 'bun:test';
import { chatTargetKey, ownerTarget } from '../src/chat/identity.ts';
import { isConditional, isDue, letterState, pickPendingDelivery } from '../src/chat/settlement.ts';
import { makeChatMessage, makePeer } from './helpers.ts';

/**
 * The one answer to "which letter is next" — used by the tmux pass, the App pass, native delivery and
 * `wait`. What it must hold is the two-track rule: immediate mail in order behind a cursor, conditional
 * mail by id, and neither able to block the other.
 */
const worker = makePeer({ session: 'worker' });
const other = makePeer({ session: 'other' });
const key = chatTargetKey(worker);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = Date.parse('2026-09-23T00:00:00.000Z');

test('the next immediate letter comes first, and the cursor catches up to it', () => {
  const ledger = [
    makeChatMessage({ id: id(1), to: other }),
    makeChatMessage({ id: id(2), to: worker, defer: true }),
    makeChatMessage({ id: id(3), to: worker }),
  ];
  const next = pickPendingDelivery(ledger, key, 0, new Set(), now);
  expect(next.pick?.msg.id).toBe(id(3));
  expect(next.cursor).toBe(2);
});

test('with no immediate letter, the first due and unresolved conditional one is next', () => {
  const ledger = [
    makeChatMessage({ id: id(1), to: worker, notBefore: '2026-09-24T00:00:00.000Z' }),
    makeChatMessage({ id: id(2), to: worker, defer: true }),
    makeChatMessage({ id: id(3), to: worker, defer: true }),
  ];
  expect(pickPendingDelivery(ledger, key, 0, new Set(), now).pick?.msg.id).toBe(id(2));
  expect(pickPendingDelivery(ledger, key, 0, new Set([id(2)]), now).pick?.msg.id).toBe(id(3));
  const none = pickPendingDelivery(ledger, key, 0, new Set([id(2), id(3)]), now);
  expect(none.pick).toBeNull();
  expect(none.cursor).toBe(3);
});

test('a letter is conditional when deferred or dated, and a bad date never traps it', () => {
  expect(isConditional({ defer: false, notBefore: null })).toBe(false);
  expect(isConditional({ defer: true, notBefore: null })).toBe(true);
  expect(isConditional({ defer: false, notBefore: '2030-01-01T00:00:00.000Z' })).toBe(true);
  expect(isDue({ notBefore: null }, now)).toBe(true);
  expect(isDue({ notBefore: '2026-09-24T00:00:00.000Z' }, now)).toBe(false);
  expect(isDue({ notBefore: 'not-a-date' }, now)).toBe(true);
});

test('a letter is settled by the record that owns its track, and no other', () => {
  const cursors = { delivered: { [key]: 2 }, telegram: 1 };
  const deferred = makeChatMessage({ id: id(1), to: worker, defer: true });
  const immediate = makeChatMessage({ id: id(2), to: worker });
  const toOwner = makeChatMessage({ id: id(3), to: ownerTarget() });
  // Conditional: the ack log decides, and a cursor already past it changes nothing.
  expect(letterState(deferred, 0, new Map(), cursors)).toBe('pending');
  expect(letterState(deferred, 0, new Map([[id(1), 'cancelled']]), cursors)).toBe('cancelled');
  // Immediate: the recipient's cursor decides, and an ack for it changes nothing.
  expect(letterState(immediate, 1, new Map(), cursors)).toBe('delivered');
  expect(letterState(immediate, 2, new Map([[id(2), 'delivered']]), cursors)).toBe('pending');
  // The owner has no pane: the mirror's index is the only cursor that ever moves for them.
  expect(letterState(toOwner, 0, new Map(), cursors)).toBe('delivered');
  expect(letterState(toOwner, 1, new Map(), cursors)).toBe('pending');
});

import { expect, test } from 'bun:test';
import { holdReason } from '../src/chat/holdReason.ts';
import { unreadFor } from '../src/chat/store.ts';
import type { ChatMessage } from '../src/types.ts';
import { makeChatMessage, makeOwner, makePeer, makeSession } from './helpers.ts';

// "It just never arrived" is what turned a mis-addressed report into hours of archaeology. Every
// hold now has a name the sender can act on.

const api = makePeer({ machine: 'test', session: 'api' });
const msg = (over: Partial<ChatMessage> = {}): ChatMessage =>
  makeChatMessage({
    id: 'm1',
    from: makePeer({ machine: 'test', session: 'a' }),
    to: api,
    body: 'x',
    ...over,
  });
const enabled = makeSession({ name: 'api', chatEnabled: true });

test('an unknown recipient points at the likely cause — it was meant for another machine', () => {
  const r = holdReason(msg(), {
    recipient: undefined,
    chatEnabled: true,
    running: false,
    nowMs: 0,
  });
  expect(r.kind).toBe('recipient-unknown');
  expect(r.text).toContain('another fleet machine');
});

test('chat-off and stopped are named with the exact command that fixes them', () => {
  expect(
    holdReason(msg(), {
      recipient: makeSession({ name: 'api' }),
      chatEnabled: false,
      running: true,
      nowMs: 0,
    }).text,
  ).toContain('ccmux chat on api');
  expect(
    holdReason(msg(), { recipient: enabled, chatEnabled: true, running: false, nowMs: 0 }).text,
  ).toContain('ccmux start api');
});

test('a scheduled message reports the remaining wait, not a fault', () => {
  const now = Date.parse('2026-08-05T00:00:00.000Z');
  const r = holdReason(msg({ notBefore: '2026-08-05T00:00:30.000Z' }), {
    recipient: enabled,
    chatEnabled: true,
    running: true,
    nowMs: now,
  });
  expect(r.kind).toBe('not-due');
  expect(r.text).toContain('30s');
});

test("the daemon's live reason wins over the generic ones", () => {
  const hold = { reason: 'a human is typing in that pane right now', msgId: 'm1' };
  const r = holdReason(msg({ defer: true }), {
    recipient: enabled,
    chatEnabled: true,
    running: true,
    nowMs: 0,
    daemonHold: hold,
  });
  expect(r.kind).toBe('live');
});

test("a gate recorded about another letter is reported as the recipient's, not as this letter's", () => {
  // Two failures are available here and they are opposite. Stamping the reason under every letter
  // as if it were about that letter mislabels them; refusing to report it at all replaces a true
  // reason with a plausible false one — measured on a session at a trust dialog, where letter one
  // named the menu and letters two through four said the daemon might not be running, sending the
  // reader to check a daemon that had just printed the real reason. The gate belongs to the
  // RECIPIENT: it travels, and it says which of the two it is.
  const hold = { reason: 'a human is typing in that pane right now', msgId: 'other' };
  const r = holdReason(msg({ id: 'm1', defer: true }), {
    recipient: enabled,
    chatEnabled: true,
    running: true,
    nowMs: 0,
    daemonHold: hold,
  });
  expect(r.kind).toBe('live');
  expect(r.text).toBe('ahead of it: a human is typing in that pane right now');
  // And a letter the gate WAS recorded about still reads as its own, with no borrowed wording.
  expect(
    holdReason(msg({ id: 'other', defer: true }), {
      recipient: enabled,
      chatEnabled: true,
      running: true,
      nowMs: 0,
      daemonHold: hold,
    }).text,
  ).toBe('a human is typing in that pane right now');
});

test("a recipient whose agent cannot receive chat is told so — never 'queued'", () => {
  // The delivery loop skips such a session outright, so promising "within a few seconds" is a lie
  // that never resolves.
  const r = holdReason(msg(), {
    recipient: enabled,
    chatEnabled: true,
    running: true,
    nowMs: 0,
    chatDeliverable: false,
  });
  expect(r.kind).toBe('agent-unsupported');
  expect(r.text).toContain('never be delivered');
});

test('mail to the human is not a fault — there is no pane to deliver into', () => {
  const r = holdReason(msg({ to: makeOwner() }), {
    recipient: undefined,
    chatEnabled: true,
    running: false,
    nowMs: 0,
    isOwner: true,
  });
  expect(r.kind).toBe('owner');
  expect(r.text).toContain('Telegram');
});

test('defer with no live record reads as waiting for the turn to end; plain mail as simply queued', () => {
  expect(
    holdReason(msg({ defer: true }), {
      recipient: enabled,
      chatEnabled: true,
      running: true,
      nowMs: 0,
    }).kind,
  ).toBe('awaiting-turn-end');
  expect(
    holdReason(msg(), { recipient: enabled, chatEnabled: true, running: true, nowMs: 0 }).kind,
  ).toBe('pending');
});

test('N9: an already-injected deferred message is no longer reported as pending forever', () => {
  // Conditional mail is delivered OFF the read cursor and recorded only in the ack-log, so without
  // consulting it `inbox` kept showing mail that had in fact been pushed into the pane.
  const ledger = [msg({ id: 'delivered', defer: true }), msg({ id: 'waiting' })];
  const cursors = { read: {}, delivered: {}, pickups: {}, telegram: 0 };
  expect(unreadFor(api, ledger, cursors).map((u) => u.msg.id)).toEqual(['delivered', 'waiting']);
  expect(unreadFor(api, ledger, cursors, new Set(['delivered'])).map((u) => u.msg.id)).toEqual([
    'waiting',
  ]);
});

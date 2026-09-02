import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliPrincipal, managedPeer } from '../src/chat/identity.ts';
import { appendAck, appendMessage, loadAcks } from '../src/chat/store.ts';
import { chatAckPath } from '../src/config/paths.ts';
import { cancelControlMessage } from '../src/control/messageCancel.ts';
import type { ChatMessage, MachineConfig } from '../src/types.ts';
import { makeMachine, makeSession } from './helpers.ts';

const recipient = makeSession({ name: 'agent-b', uuid: '22222222-2222-4222-8222-222222222222' });

function setup(): { m: MachineConfig } {
  return { m: makeMachine({ stateDir: mkdtempSync(join(tmpdir(), 'ccmux-cancel-')) }) };
}

const letter = (m: MachineConfig, from: ChatMessage['from'], defer: boolean): ChatMessage => {
  const message: ChatMessage = {
    v: 2,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from,
    to: managedPeer(m.rcPrefix, recipient),
    body: 'text',
    task: null,
    defer,
    onBehalfOf: null,
    notBefore: null,
  };
  appendMessage(m, message);
  return message;
};

test('a waiting letter of the caller is withdrawn, and says so a second time', () => {
  const { m } = setup();
  const me = cliPrincipal(m.rcPrefix);
  const message = letter(m, me, true);
  expect(cancelControlMessage(m, { messageId: message.id }, me).outcome).toBe('cancelled');
  expect(loadAcks(m).get(message.id)).toBe('cancelled');
  // Idempotent, and still the truth: it was cancelled, and asking again does not make it delivered.
  expect(cancelControlMessage(m, { messageId: message.id }, me).outcome).toBe('cancelled');
  // And it writes nothing the second time. The ack log is append-only, so a repeat that tombstones
  // again leaves two records of one act — history that reads as two cancellations.
  expect(readFileSync(chatAckPath(m), 'utf8').trim().split('\n')).toHaveLength(1);
});

test('a letter that already arrived says delivered, not cancelled', () => {
  const { m } = setup();
  const me = cliPrincipal(m.rcPrefix);
  const message = letter(m, me, true);
  appendAck(m, message.id, 'daemon', message.to);
  // Both outcomes suppress future delivery, which is exactly why they must not share a word: a
  // caller rendering this as "cancelled" tells its user the opposite of what happened.
  expect(cancelControlMessage(m, { messageId: message.id }, me).outcome).toBe('delivered');
});

test('an immediate letter has no interval in which to be taken back', () => {
  const { m } = setup();
  const me = cliPrincipal(m.rcPrefix);
  const message = letter(m, me, false);
  expect(cancelControlMessage(m, { messageId: message.id }, me).outcome).toBe('delivered');
  // And nothing was written: a tombstone for a letter that never waits is a lie in an append-only log.
  expect(loadAcks(m).has(message.id)).toBe(false);
});

test("another party's letter is refused by name, not reported as missing", () => {
  const { m } = setup();
  const mine = cliPrincipal(m.rcPrefix);
  const theirs = managedPeer(m.rcPrefix, makeSession({ name: 'agent-c' }));
  const message = letter(m, theirs, true);
  // "unknown" would disguise a permissions answer as a missing one, and send the caller looking for
  // a letter that is sitting right there.
  expect(cancelControlMessage(m, { messageId: message.id }, mine).outcome).toBe('not-yours');
  expect(loadAcks(m).has(message.id)).toBe(false);
});

test('a letter this machine never accepted is unknown', () => {
  const { m } = setup();
  expect(
    cancelControlMessage(m, { messageId: crypto.randomUUID() }, cliPrincipal(m.rcPrefix)).outcome,
  ).toBe('unknown');
});

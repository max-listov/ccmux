import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEnvelope } from '../src/chat/compose.ts';
import { rowFromLedgerRecord, rowFromOutbound } from '../src/chat/fleetLog.ts';
import { externalTarget, servicePrincipal } from '../src/chat/identity.ts';
import { rowsAfter, ZERO_CURSOR } from '../src/chat/logFeed.ts';
import {
  appendMessage,
  appendMessageOnce,
  chatPaths,
  loadCursors,
  loadLedger,
  saveCursors,
} from '../src/chat/store.ts';
import { mirrorPending } from '../src/chat/telegram.ts';
import { makeChatMessage, makeMachine, makeOwner, makePeer } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-audience-'));
  roots.push(root);
  return makeMachine({
    stateDir: root,
    telegram: { botToken: 'fixture-token', chatId: 'fixture-chat' },
    externals: { specialist: 'external conversation' },
  });
}

test('suppressed history, human input and peer traffic advance without a send; later owner/courier notices survive', async () => {
  const m = fixture();
  const old = makeChatMessage({ to: makeOwner(), body: 'historical' });
  delete old.origin;
  delete old.notification;
  appendMessage(m, old);
  appendMessage(
    m,
    buildEnvelope(servicePrincipal('host-a', 'declared-service'), makePeer(), 'human conversation'),
  );
  appendMessage(m, buildEnvelope(makePeer(), makePeer({ session: 'other' }), 'peer coordination'));
  appendMessage(m, buildEnvelope(makePeer(), makeOwner(), 'explicit notice'));
  appendMessage(m, buildEnvelope(makePeer(), makeOwner(), 'explicit notice'));
  appendMessage(m, buildEnvelope(makePeer(), externalTarget('specialist'), 'courier request'));
  await saveCursors(m, { ...loadCursors(m), telegram: 0 });
  const sent: string[] = [];
  await mirrorPending(m, async (_tg, text) => {
    sent.push(text);
    return 'ok';
  });
  expect(sent).toHaveLength(3);
  expect(sent[0]).toContain('explicit notice');
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2]).toContain('courier request');
  expect(sent.join(' ')).not.toContain('human conversation');
  expect(loadCursors(m).telegram).toBe(6);
  await mirrorPending(m, async () => {
    throw new Error('replayed');
  });
});

test('uncertain Telegram send holds the cursor; retry may duplicate, permanent failure advances', async () => {
  const m = fixture();
  appendMessage(m, buildEnvelope(makePeer(), makePeer(), 'quiet'));
  appendMessage(m, buildEnvelope(makePeer(), makeOwner(), 'notice'));
  await saveCursors(m, { ...loadCursors(m), telegram: 0 });
  let requests = 0;
  await mirrorPending(m, async () => {
    requests++;
    return 'transient';
  });
  expect(requests).toBe(1);
  expect(loadCursors(m).telegram).toBe(1);
  // A sink may have accepted the first request before its response was lost. We must retry,
  // not claim exactly-once or advance on uncertainty.
  await mirrorPending(m, async () => {
    requests++;
    return 'ok';
  });
  expect(requests).toBe(2);
  expect(loadCursors(m).telegram).toBe(2);
  appendMessage(m, buildEnvelope(makePeer(), makeOwner(), 'permanent refusal'));
  await mirrorPending(m, async () => {
    requests++;
    return 'permanent';
  });
  expect(requests).toBe(3);
  expect(loadCursors(m).telegram).toBe(3);
});

test('transport retry cannot change provenance or audience, but identical bodies with distinct IDs survive', async () => {
  const m = fixture();
  const message = buildEnvelope(makePeer(), makePeer(), 'same body');
  expect(await appendMessageOnce(m, message)).toBe(true);
  expect(await appendMessageOnce(m, message)).toBe(false);
  await expect(appendMessageOnce(m, { ...message, notification: 'owner' })).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await expect(
    appendMessageOnce(m, {
      ...message,
      origin: { ingress: 'cli', actor: 'unknown', assurance: 'unknown', application: null },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  expect(await appendMessageOnce(m, { ...message, id: crypto.randomUUID() })).toBe(true);
  expect(loadLedger(m)).toHaveLength(2);
});

test('history normalization is read-only; snapshot, sent copies and resume retain message identity', () => {
  const m = fixture();
  const historical = makeChatMessage();
  delete historical.origin;
  delete historical.notification;
  appendMessage(m, historical);
  const original = readFileSync(chatPaths(m).ledger);
  const row = rowFromLedgerRecord(m.rcPrefix, loadLedger(m)[0] ?? null);
  expect(row.origin).toEqual({
    ingress: 'unknown',
    actor: 'unknown',
    assurance: 'unknown',
    application: null,
  });
  expect(row.notification).toBe('conversation');
  expect(readFileSync(chatPaths(m).ledger)).toEqual(original);
  const message = buildEnvelope(makePeer(), makePeer({ machine: 'host-b' }), 'current');
  appendFileSync(chatPaths(m).ledger, `${JSON.stringify(message)}\n`);
  const first = rowsAfter(m, ZERO_CURSOR);
  const rows = first.frames.filter((frame) => frame.kind === 'row');
  expect(rows.at(-1)?.row).toEqual(rowFromLedgerRecord(m.rcPrefix, message));
  expect(rowsAfter(m, first.cursor).frames.filter((frame) => frame.kind === 'row')).toHaveLength(0);
  const sent = rowFromOutbound(m.rcPrefix, {
    kind: 'msg',
    envelope: message,
    result: { ok: true, detail: '' },
  });
  expect(sent.messageId).toBe(message.id);
  expect(message.origin).toEqual(sent.origin);
  expect(sent.sender).toEqual(message.from);
  expect(sent.notification).toBe('conversation');
});

import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRows } from '../src/chat/fleetLog.ts';
import { outboxAckPath, outboxPath } from '../src/config/paths.ts';
import { MachineConfigSchema } from '../src/config/schema.ts';
import {
  appendOutboxAck,
  loadOutboxAcked,
  RETRY_WINDOW_MS,
  retryCandidates,
} from '../src/fleet/flush.ts';
import type { Outbound } from '../src/fleet/outbox.ts';
import { appendOutbound, outboundId } from '../src/fleet/outbox.ts';
import { makeChatMessage, makePeer } from './helpers.ts';

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-flush-'));
  return MachineConfigSchema.parse({
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/p',
    rcPrefix: 'test',
    stateDir: dir,
    bootLabel: 'b',
  });
}

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const rec = (o: { id?: string; ts?: string; ok?: boolean; detail?: string } = {}): Outbound => {
  const id = o.id ?? randomUUID();
  const ts = o.ts ?? new Date(NOW - 60_000).toISOString();
  const from = makePeer({ session: 'agent-a' });
  const to = makePeer({ machine: 'host-b', agent: 'codex', session: 'agent-b' });
  const result = { ok: o.ok ?? false, detail: o.detail ?? 'transport failed' };
  return {
    kind: 'msg',
    envelope: makeChatMessage({ id, ts, from, to, body: 'the answer' }),
    result,
  };
};

test('a recent failed message is a retry candidate', () => {
  const record = rec();
  expect(retryCandidates([record], new Set(), NOW).map(outboundId)).toEqual([outboundId(record)]);
});

test('what must never be retried: successes, stale rows, already-settled ids', () => {
  const rows = [
    rec({ id: 'ok', ok: true }),
    rec({ id: 'stale', ts: new Date(NOW - RETRY_WINDOW_MS - 1000).toISOString() }),
    rec({ id: 'settled' }),
    rec({ id: 'live' }),
  ];
  expect(retryCandidates(rows, new Set(['settled']), NOW).map(outboundId)).toEqual(['live']);
});

test('the same id is offered once, however many attempts it has on record', () => {
  const rows = [rec({ id: 'same' }), rec({ id: 'same', ts: new Date(NOW - 30_000).toISOString() })];
  expect(retryCandidates(rows, new Set(), NOW)).toHaveLength(1);
});

test('acks round-trip and live beside the outbox, not inside it', () => {
  const m = tempConfig();
  expect(loadOutboxAcked(m).size).toBe(0);
  appendOutbound(m, rec());
  appendOutboxAck(m, 'id-1');
  expect(loadOutboxAcked(m).has('id-1')).toBe(true);
  // The outbox stays an immutable record of ATTEMPTS; what finally landed is a separate file.
  expect(outboxAckPath(m)).not.toBe(outboxPath(m));
});

test('a message that arrived on retry stops being reported as lost', () => {
  const failed = rec({ id: 'late' });
  const shouting = localRows('host-a', [], [failed]);
  expect(shouting[0]?.note).toContain('NOT SENT');
  const settled = localRows('host-a', [], [failed], new Set(['late']));
  expect(settled[0]?.note).toBe('sent later, on retry');
});

test('an unparseable timestamp is skipped rather than retried forever', () => {
  expect(retryCandidates([rec({ ts: 'not-a-date' })], new Set(), NOW)).toEqual([]);
});

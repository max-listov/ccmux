import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatPrincipalKey, managedPeerKey } from '../src/chat/identity.ts';
import {
  appendMessage,
  chatPaths,
  fmtMessage,
  loadCursors,
  loadLedger,
  markRead,
  nextForRecipient,
  pendingConditional,
  unreadableCount,
  unreadFor,
} from '../src/chat/store.ts';
import { CHAT_GENERATION, MachineConfigSchema } from '../src/config/schema.ts';
import type {
  AgentKind,
  ChatMessage,
  ChatPrincipal,
  ChatTarget,
  ManagedPeer,
} from '../src/types.ts';

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-chat-'));
  return MachineConfigSchema.parse({
    claudeBin: '/bin/claude',
    tmuxBin: '/bin/tmux',
    projectsDir: '/p',
    rcPrefix: 'test',
    stateDir: dir,
    bootLabel: 'b',
  });
}

const THREAD_A = '11111111-1111-4111-8111-111111111111';
const THREAD_B = '22222222-2222-4222-8222-222222222222';
const THREAD_C = '33333333-3333-4333-8333-333333333333';

function peer(
  session: string,
  threadId: string,
  agent: AgentKind = 'claude',
  machine = 'host-a',
): ManagedPeer {
  return { kind: 'managed', source: 'ccmux', machine, agent, session, threadId };
}

function msg(
  from: ChatPrincipal,
  to: ChatTarget,
  body: string,
  task: string | null = null,
): ChatMessage {
  return {
    v: CHAT_GENERATION,
    id: randomUUID(),
    ts: '2026-07-19T10:00:00.000Z',
    from,
    to,
    body,
    task,
    defer: false,
    onBehalfOf: null,
    notBefore: null,
  };
}

test('append + loadLedger round-trips a full immutable envelope', () => {
  const m = tempConfig();
  const a = peer('agent-a', THREAD_A);
  const b = peer('agent-b', THREAD_B, 'codex');
  appendMessage(m, msg(a, b, 'one'));
  expect(loadLedger(m)[0]).toEqual(expect.objectContaining({ from: a, to: b, body: 'one' }));
});

test('unread cursors key the exact managed peer, not its reusable session name', async () => {
  const m = tempConfig();
  const sender = peer('sender', THREAD_A);
  const oldTarget = peer('worker', THREAD_B, 'claude');
  const reusedTarget = peer('worker', THREAD_C, 'codex');
  appendMessage(m, msg(sender, oldTarget, 'old thread only'));

  const ledger = loadLedger(m);
  expect(unreadFor(oldTarget, ledger, loadCursors(m))).toHaveLength(1);
  expect(unreadFor(reusedTarget, ledger, loadCursors(m))).toEqual([]);
  await markRead(m, oldTarget, ledger.length);
  expect(loadCursors(m).read[managedPeerKey(oldTarget)]).toBe(1);
  expect(loadCursors(m).read[managedPeerKey(reusedTarget)]).toBeUndefined();
});

test('nextForRecipient requires the full pinned target tuple', () => {
  const sender = peer('sender', THREAD_A);
  const oldTarget = peer('worker', THREAD_B, 'claude');
  const reusedTarget = peer('worker', THREAD_C, 'codex');
  const ledger = [msg(sender, oldTarget, 'old')];
  expect(nextForRecipient(oldTarget, ledger, 0)?.idx).toBe(0);
  expect(nextForRecipient(reusedTarget, ledger, 0)).toBeNull();
});

test('conditional dedup filters by exact principal and target identity', () => {
  const sender = peer('sender', THREAD_A);
  const otherSender = peer('sender', THREAD_C, 'codex');
  const target = peer('worker', THREAD_B);
  const conditional = {
    ...msg(sender, target, 'watch', 'job'),
    notBefore: '2026-08-11T00:00:00.000Z',
  };
  expect(
    pendingConditional([conditional], new Set(), { from: sender, to: target, task: 'job' }),
  ).toEqual([conditional]);
  expect(
    pendingConditional([conditional], new Set(), { from: otherSender, to: target, task: 'job' }),
  ).toEqual([]);
});

test('fmtMessage exposes source, provider, machine, session and thread', () => {
  const rendered = fmtMessage(
    msg(peer('agent-a', THREAD_A, 'claude'), peer('agent-b', THREAD_B, 'codex', 'host-b'), 'hello'),
  );
  expect(rendered).toContain(`ccmux/claude@host-a:agent-a#${THREAD_A}`);
  expect(rendered).toContain(`ccmux/codex@host-b:agent-b#${THREAD_B}`);
});

test('stable keys distinguish provider, thread and cli principal', () => {
  const claude = peer('worker', THREAD_A, 'claude');
  const codex = peer('worker', THREAD_A, 'codex');
  expect(managedPeerKey(claude)).not.toBe(managedPeerKey(codex));
  expect(chatPrincipalKey({ kind: 'cli', source: 'ccmux', machine: 'host-a' })).toBe(
    'ccmux:host-a:cli',
  );
});

test('a record from an older generation fails LOUD, and says which generation it is', () => {
  // The cutover is deliberate: records written before the identity model carry no provider or thread,
  // and guessing those in would misroute mail. What must not happen is a SILENT skip — that turns a
  // stale file into invisible data loss. The generation lives in the record, so the refusal can name
  // the cause instead of complaining about a field shape, and point at where such records belong.
  const m = tempConfig();
  writeFileSync(chatPaths(m).ledger, `${JSON.stringify({ id: 'old', from: 'a', to: 'b' })}\n`);
  expect(() => loadLedger(m)).toThrow(/generation none, this build reads 2/);
  expect(() => loadLedger(m)).toThrow(/archive/);
});

test('a record from a NEWER build is stepped over, and its position is kept', () => {
  // The two directions are NOT symmetric, and treating them alike is what made this dangerous. An
  // older record needs a person to migrate it, so it stops the read. A newer one needs nothing from
  // anyone — this machine reads it once it is upgraded. Refusing the file for it would take down
  // `msg`, `inbox`, delivery and the TUI at once, on every machine that had not upgraded yet, and
  // the fleet always has such a window: rollout takes minutes and a rollback is legitimate.
  const m = tempConfig();
  const mine = msg(
    { kind: 'cli', source: 'ccmux', machine: 'test' },
    peer('agent-a', THREAD_A),
    'mine',
  );
  writeFileSync(
    chatPaths(m).ledger,
    `${JSON.stringify({ v: 99, id: 'x', ts: 'now', from: 'a', to: 'b', body: 'y' })}\n${JSON.stringify(mine)}\n`,
  );
  const slots = loadLedger(m);
  expect(slots.length).toBe(2); // the hole is kept — delivery cursors are POSITIONS in this array
  expect(slots[0]).toBeNull();
  expect(slots[1]?.id).toBe(mine.id);
  expect(unreadableCount(slots)).toBe(1);
});

test('a record of THIS generation that is merely extended is skew, not damage', () => {
  // What a newer build actually does: adds a field, or a kind of address this one has no case for.
  // Everything the current generation requires is still there, so it is skipped rather than fatal.
  const m = tempConfig();
  const extended = {
    ...msg({ kind: 'cli', source: 'ccmux', machine: 'test' }, peer('agent-a', THREAD_A), 'x'),
    somethingNewer: true,
    to: { kind: 'external', source: 'ccmux', name: 'someone' },
  };
  writeFileSync(chatPaths(m).ledger, `${JSON.stringify(extended)}\n`);
  const slots = loadLedger(m);
  expect(slots).toEqual([null]);
});

test('a record MISSING what every record of this generation carries is still fatal', () => {
  // The other half of the line. A writer bug that goes quiet is a bug nobody fixes, so "written by
  // something newer" and "malformed" are decided apart rather than lumped together.
  const m = tempConfig();
  writeFileSync(
    chatPaths(m).ledger,
    `${JSON.stringify({ v: 2, id: 'x', ts: 'now', from: { kind: 'cli' }, to: { kind: 'owner' }, body: 'y' })}\n`,
  );
  expect(() => loadLedger(m)).toThrow(/malformed/);
});

test('a name-only row that DOES claim the current generation still fails closed', () => {
  // The generation check is a better error, not a replacement for strict validation.
  const m = tempConfig();
  writeFileSync(
    chatPaths(m).ledger,
    `${JSON.stringify({ v: 2, id: 'old', ts: 'now', from: 'a', to: 'b', body: 'x' })}\n`,
  );
  expect(() => loadLedger(m)).toThrow();
});

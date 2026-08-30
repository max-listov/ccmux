import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { managedPeer } from '../src/chat/identity.ts';
import { MESSAGE_OPERATION_LIMITS } from '../src/chat/messageOperationSchema.ts';
import {
  advanceMessageOperation,
  prepareMessageOperation,
} from '../src/chat/messageOperationStore.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { readMessageOperation } from '../src/control/messageOperation.ts';
import { managedRuntimeRoot } from '../src/runtime/status.ts';
import { makeCli, makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
async function fixture(runtime: 'codex' | 'opencode' = 'codex') {
  const root = mkdtempSync('/tmp/ccmux-correlation-');
  roots.push(root);
  const m = makeMachine({ stateDir: root, rcPrefix: 'host-a' });
  const s = makeSession({
    agent: runtime,
    runtime: runtime === 'codex' ? 'app-server' : 'native',
    registrationGeneration: crypto.randomUUID(),
    ...(runtime === 'opencode'
      ? { nativeSession: { runtime, id: 'ses_native', version: '1.18.20' } }
      : {}),
  });
  await writeSessionsUnlocked(m, [s]);
  const from = makeCli('host-b');
  const input = {
    target: managedPeer(m.rcPrefix, s),
    registrationGeneration: s.registrationGeneration ?? '',
    messageId: crypto.randomUUID(),
  };
  const read = (now?: number) => readMessageOperation(m, from, input, now);
  return {
    m,
    s,
    from,
    input,
    read,
    prepare: (now?: number) =>
      prepareMessageOperation(m, s, from, input.messageId, 'a'.repeat(64), now),
    advance: (
      phase: Parameters<typeof advanceMessageOperation>[3],
      turn: string | null = null,
      now?: number,
    ) => advanceMessageOperation(m, s, input.messageId, phase, turn, now),
  };
}

for (const runtime of ['codex', 'opencode'] satisfies Array<'codex' | 'opencode'>) {
  test(`${runtime}: exact durable binding survives pickup/history eviction and reopened readers`, async () => {
    const f = await fixture(runtime);
    expect(f.read().outcome).toBe('unavailable');
    f.prepare();
    expect(f.read().evidence?.state).toBe('uncertain');
    f.advance('queued');
    expect(f.read().evidence).toMatchObject({ state: 'queued', turnId: null });
    f.advance('uncertain');
    f.advance('admitted', 'turn-exact');
    expect(() => f.advance('admitted', 'turn-other')).toThrow('evidence is unavailable');
    f.advance('completed', 'turn-exact');
    const complete = f.read();
    f.prepare();
    f.advance('queued');
    f.advance('uncertain');
    expect(f.read()).toEqual(complete);
    expect(readMessageOperation(f.m, f.from, f.input)).toEqual(complete);
    expect(complete.evidence).toMatchObject({
      state: 'completed',
      turnId: 'turn-exact',
      nativeSession: { runtime },
    });
    expect(complete.evidence?.expiresAt).not.toBeNull();
  });
}

test('caller/target/registration isolation, missing evidence and corruption fail closed', async () => {
  const f = await fixture();
  f.prepare();
  f.advance('queued');
  expect(readMessageOperation(f.m, makeCli('host-c'), f.input).outcome).toBe('unavailable');
  expect(
    readMessageOperation(f.m, f.from, { ...f.input, messageId: crypto.randomUUID() }).outcome,
  ).toBe('unavailable');
  expect(
    readMessageOperation(f.m, f.from, { ...f.input, registrationGeneration: crypto.randomUUID() })
      .outcome,
  ).toBe('unavailable');
  expect(
    readMessageOperation(f.m, f.from, {
      ...f.input,
      target: { ...f.input.target, threadId: crypto.randomUUID() },
    }).outcome,
  ).toBe('unavailable');
  const path = join(managedRuntimeRoot(f.m, f.s), 'message-receipts.json');
  writeFileSync(path, '{invalid', { mode: 0o600 });
  expect(f.read()).toMatchObject({ outcome: 'unavailable', evidence: null });
  expect(() => f.prepare()).toThrow();
  writeFileSync(path, 'x'.repeat(MESSAGE_OPERATION_LIMITS.bytes + 1), { mode: 0o600 });
  expect(f.read()).toMatchObject({ outcome: 'unavailable', evidence: null });
});

test('expiry is explicit and bounded eviction never removes pending operations', async () => {
  const f = await fixture();
  const now = Date.now();
  f.prepare(now);
  f.advance('completed', 'turn-exact', now);
  expect(f.read(now + MESSAGE_OPERATION_LIMITS.terminalTtlMs)).toMatchObject({
    outcome: 'expired',
    evidence: null,
  });
  for (let i = 1; i < MESSAGE_OPERATION_LIMITS.records; i++)
    prepareMessageOperation(f.m, f.s, f.from, crypto.randomUUID(), 'a'.repeat(64), now);
  prepareMessageOperation(f.m, f.s, f.from, crypto.randomUUID(), 'a'.repeat(64), now);
  expect(f.read().outcome).toBe('unavailable');
  expect(() =>
    prepareMessageOperation(f.m, f.s, f.from, crypto.randomUUID(), 'a'.repeat(64), now),
  ).toThrow('capacity');
});

test('identical input fingerprints keep distinct UUIDs and immutable native bindings', async () => {
  const f = await fixture();
  f.prepare();
  f.advance('admitted', 'first');
  const second = { ...f.input, messageId: crypto.randomUUID() };
  prepareMessageOperation(f.m, f.s, f.from, second.messageId, 'a'.repeat(64));
  advanceMessageOperation(f.m, f.s, second.messageId, 'queued');
  expect(() => advanceMessageOperation(f.m, f.s, second.messageId, 'admitted', 'first')).toThrow(
    'evidence is unavailable',
  );
  expect(readMessageOperation(f.m, f.from, second).evidence).toMatchObject({
    state: 'queued',
    turnId: null,
  });
  f.advance('completed', 'first');
  advanceMessageOperation(f.m, f.s, second.messageId, 'completed', 'second');
  expect(f.read().evidence?.turnId).toBe('first');
  expect(readMessageOperation(f.m, f.from, second).evidence?.turnId).toBe('second');
  expect(() =>
    prepareMessageOperation(f.m, f.s, f.from, second.messageId, 'b'.repeat(64)),
  ).toThrow();
  expect(JSON.stringify(f.read())).not.toContain('principal');
  expect(JSON.stringify(f.read())).not.toContain(f.m.stateDir);
});

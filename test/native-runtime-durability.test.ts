import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { managedPeer, managedPeerKey } from '../src/chat/identity.ts';
import { deliverNativeRuntimePending } from '../src/chat/nativeRuntime.ts';
import { ChatCursorsSchema } from '../src/config/schema.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import { captureNativeStderr, recordRuntimeDiagnostic } from '../src/runtime/diagnostics.ts';
import { readRuntimeInput, writeRuntimeInput } from '../src/runtime/input.ts';
import { ManagedRuntimeStatusWriter, managedRuntimeRoot } from '../src/runtime/status.ts';
import { makeChatMessage, makeMachine, makeSession } from './helpers.ts';

async function fixture() {
  const m = makeMachine({
    stateDir: mkdtempSync('/tmp/ccmux-native-durability-'),
    rcPrefix: 'host-a',
  });
  const s = makeSession({
    name: 'native',
    agent: 'opencode',
    runtime: 'native',
    registrationGeneration: crypto.randomUUID(),
    nativeSession: { runtime: 'opencode', id: 'ses_native', version: '1.18.20' },
  });
  await writeSessionsUnlocked(m, [s]);
  const projection = new OpenCodeProjection(m, s, process.pid);
  projection.status({ type: 'idle' });
  const writer = new ManagedRuntimeStatusWriter(m, s);
  await writer.write(projection.snapshot());
  const peer = managedPeer(m.rcPrefix, s),
    key = managedPeerKey(peer);
  const msg = makeChatMessage({ to: peer });
  const cursors = ChatCursorsSchema.parse({});
  cursors.delivered[key] = 1;
  cursors.pickups[key] = {
    messageId: msg.id,
    ledgerIndex: 0,
    conditional: false,
    injectedAt: new Date().toISOString(),
    native: { phase: 'intent', turnId: null },
  };
  return { m, s, projection, writer, peer, key, msg, cursors };
}

test('native cursor intent recovers the mailbox crash gap exactly once', async () => {
  const { m, s, msg, cursors } = await fixture();
  expect(await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false)).toBe(1);
  const queued = readRuntimeInput(m, s);
  expect(queued).toMatchObject({ messageId: msg.id, phase: 'queued' });
  expect(await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false)).toBe(0);
  expect(readRuntimeInput(m, s)).toEqual(queued);
});

test('a corrupt or uncertain native receipt cannot be repaired into a second dispatch', async () => {
  const { m, s, msg, cursors } = await fixture();
  await writeRuntimeInput(m, s, {
    messageId: crypto.randomUUID(),
    nativeId: 'msg_old',
    text: 'old',
    phase: 'uncertain',
  });
  expect(await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false)).toBe(0);
  expect(readRuntimeInput(m, s)?.phase).toBe('uncertain');
  writeFileSync(join(managedRuntimeRoot(m, s), 'input.json'), '{invalid', { mode: 0o600 });
  await expect(deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false)).rejects.toThrow(
    'journal is invalid',
  );
});

test('native cursor recovery replaces only a proven terminal previous receipt', async () => {
  const { m, s, projection, writer, msg, cursors } = await fixture();
  projection.start('msg_old');
  projection.message({
    id: 'msg_answer',
    sessionID: 'ses_native',
    role: 'assistant',
    parentID: 'msg_old',
    time: { created: 1, completed: 2 },
    finish: 'stop',
  });
  await writer.write(projection.snapshot());
  await writeRuntimeInput(m, s, {
    messageId: crypto.randomUUID(),
    nativeId: 'msg_old',
    text: 'old',
    phase: 'accepted',
  });
  expect(await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false)).toBe(1);
  expect(readRuntimeInput(m, s)?.messageId).toBe(msg.id);
});

test('text deltas retain role and causal order while private native errors stay out of projection', () => {
  const m = makeMachine(),
    s = makeSession({
      agent: 'opencode',
      nativeSession: { runtime: 'opencode', id: 'ses_native', version: '1.18.20' },
    });
  const errors: unknown[] = [],
    projection = new OpenCodeProjection(m, s, process.pid, (error) => errors.push(error));
  projection.start('msg_user');
  projection.status({ type: 'idle' });
  expect(projection.snapshot()).toMatchObject({
    state: 'unknown',
    reason: 'awaiting-terminal-evidence',
  });
  projection.part({
    id: 'part_user',
    sessionID: 'ses_native',
    messageID: 'msg_user',
    type: 'text',
    text: 'hello',
  });
  expect(projection.snapshot().nativeItems.at(-1)?.kind).toBe('user');
  const message = {
    id: 'msg_answer',
    sessionID: 'ses_native',
    role: 'assistant',
    parentID: 'msg_user',
    time: { created: Date.now() },
  } satisfies Parameters<typeof projection.message>[0];
  projection.message(message);
  projection.part({
    id: 'part_answer',
    sessionID: 'ses_native',
    messageID: 'msg_answer',
    type: 'text',
    text: 'a',
  });
  projection.event({
    type: 'message.part.delta',
    properties: {
      sessionID: 'ses_native',
      messageID: 'msg_answer',
      partID: 'part_answer',
      field: 'text',
      delta: 'b',
    },
  });
  expect(projection.snapshot().nativeItems.at(-1)).toMatchObject({
    kind: 'assistant',
    stage: 'updated',
    text: 'ab',
  });
  projection.part({
    id: 'part_tool',
    sessionID: 'ses_native',
    messageID: 'msg_answer',
    type: 'tool',
    tool: 'shell',
    state: {
      status: 'completed',
      input: { command: 'secret-like-fixture' },
      output: 'secret-like-fixture',
    },
  });
  expect(projection.snapshot().nativeItems.at(-1)).toMatchObject({ kind: 'tool', text: null });
  projection.message({ ...message, error: { name: 'NativeError', data: 'secret-like-fixture' } });
  expect(errors).toHaveLength(1);
  expect(JSON.stringify(errors)).toContain('secret-like-fixture');
  expect(JSON.stringify(projection.snapshot())).not.toContain('secret-like-fixture');
  expect(projection.snapshot().events.filter((event) => event.kind === 'turn-end')).toHaveLength(1);
});

test('native diagnostic capture is bounded and written only to a private owner file', async () => {
  const m = makeMachine({ stateDir: mkdtempSync('/tmp/ccmux-native-diagnostic-') });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(`${'a'.repeat(80_000)}secret-like-fixture`));
      controller.close();
    },
  });
  const stderr = captureNativeStderr(stream);
  await stderr.closed;
  expect(Buffer.byteLength(stderr.text())).toBe(32_768);
  await recordRuntimeDiagnostic(m, 'native', 'probe', new Error('native failure'), stderr.text());
  const file = join(
    m.stateDir,
    'native-diagnostics',
    readdirSync(join(m.stateDir, 'native-diagnostics'))[0] ?? '',
  );
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, 'utf8')).toContain('secret-like-fixture');
});

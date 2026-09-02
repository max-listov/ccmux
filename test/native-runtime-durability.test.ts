import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenCodeProjection } from '../src/agent/opencode/projection.ts';
import { managedPeer, managedPeerKey } from '../src/chat/identity.ts';
import { prepareMessageOperation, readMessageJournal } from '../src/chat/messageOperationStore.ts';
import { deliverNativeRuntimePending } from '../src/chat/nativeRuntime.ts';
import { ChatCursorsSchema } from '../src/config/schema.ts';
import { writeSessionsUnlocked } from '../src/config/sessions.ts';
import {
  captureNativeStderr,
  readRuntimeDiagnostics,
  recordRuntimeDiagnostic,
} from '../src/runtime/diagnostics.ts';
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
  prepareMessageOperation(m, s, msg.from, msg.id, 'a'.repeat(64));
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

test('native accepted mailbox retains exact terminal correlation after pickup deletion', async () => {
  const { m, s, msg, cursors, projection, writer, key } = await fixture();
  await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false);
  const input = readRuntimeInput(m, s);
  if (input === null) throw new Error('fixture mailbox missing');
  await writeRuntimeInput(m, s, { ...input, phase: 'uncertain' });
  await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false);
  expect(readMessageJournal(m, s)?.records[0]?.turnId).toBeNull();
  await writeRuntimeInput(m, s, { ...input, phase: 'accepted' });
  projection.start(input.nativeId);
  projection.message({
    id: 'msg_answer',
    sessionID: 'ses_native',
    role: 'assistant',
    parentID: input.nativeId,
    time: { created: 1, completed: 2 },
    finish: 'stop',
  });
  await writer.write(projection.snapshot());
  await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false);
  expect(cursors.pickups[key]).toBeUndefined();
  expect(readMessageJournal(m, s)?.records[0]).toMatchObject({
    messageId: msg.id,
    phase: 'completed',
    turnId: input.nativeId,
  });
  await deliverNativeRuntimePending(m, s, [msg], cursors, new Set(), false);
  expect(readRuntimeInput(m, s)?.nativeId).toBe(input.nativeId);
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

test('a recorded diagnostic is reachable by the session name an operator has', async () => {
  const stateDir = mkdtempSync('/tmp/ccmux-diagnostic-read-');
  const m = makeMachine({ stateDir });

  // Nothing recorded is its own answer, and it must not be confused with the other two below.
  expect(await readRuntimeDiagnostics(m, 'agent-a')).toEqual({ matched: [], unattributed: 0 });

  await recordRuntimeDiagnostic(m, 'agent-a', 'claude-native-runtime', new Error('child is gone'));
  await recordRuntimeDiagnostic(m, 'agent-a', 'model-catalog', new Error('catalog refused'));
  await recordRuntimeDiagnostic(m, 'agent-b', 'claude-native-runtime', new Error('not yours'));

  const mine = await readRuntimeDiagnostics(m, 'agent-a');
  expect(mine.matched).toHaveLength(2);
  expect(mine.matched.map((entry) => entry.stage).sort()).toEqual([
    'claude-native-runtime',
    'model-catalog',
  ]);
  expect(mine.matched.map((entry) => entry.detail).join('\n')).toContain('child is gone');
  // A neighbour's evidence is a neighbour's: the read must not widen to whatever is on disk.
  expect(JSON.stringify(mine.matched)).not.toContain('not yours');
  expect(mine.unattributed).toBe(0);

  // A record written before the session name was stored is COUNTED, never claimed — reporting it
  // as "nothing recorded" would answer "there is no evidence" to "I could not read it".
  const root = join(stateDir, 'native-diagnostics');
  const [first] = readdirSync(root).filter((entry) => entry.endsWith('.json'));
  if (first === undefined) throw new Error('fixture wrote no diagnostic');
  const legacy: Record<string, unknown> = JSON.parse(readFileSync(join(root, first), 'utf8'));
  delete legacy.name;
  writeFileSync(join(root, 'legacy.json'), JSON.stringify(legacy));

  const withLegacy = await readRuntimeDiagnostics(m, 'agent-a');
  expect(withLegacy.unattributed).toBe(1);
  expect(withLegacy.matched).toHaveLength(2);
  expect(await readRuntimeDiagnostics(m, 'agent-never-existed')).toEqual({
    matched: [],
    unattributed: 1,
  });
});

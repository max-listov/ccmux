import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { ContentBuffer } from '../src/content/buffer.ts';
import { observeCodexContent } from '../src/content/codex.ts';
import { OpenCodeContentObserver } from '../src/content/opencode.ts';
import { contentFrame } from '../src/content/read.ts';
import { ContentSnapshotSchema } from '../src/content/schema.ts';
import { type ToolObservation, ToolObservationSchema } from '../src/content/toolSchema.ts';
import { codexContextApi } from '../src/context/codex.ts';
import { openCodeContextApi } from '../src/context/opencode.ts';
import { makeMachine, makeSession } from './helpers.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(runtime: 'codex' | 'opencode') {
  const stateDir = mkdtempSync('/tmp/ccmux-tool-observation-');
  roots.push(stateDir);
  const m = makeMachine({ stateDir, rcPrefix: 'host-a' });
  const s = makeSession({
    agent: runtime,
    runtime: runtime === 'codex' ? 'app-server' : 'native',
    registrationGeneration: crypto.randomUUID(),
    ...(runtime === 'opencode'
      ? { nativeSession: { runtime, id: 'ses_tools', version: '1.18.20' } }
      : {}),
  });
  const generation = crypto.randomUUID();
  return { m, s, generation, buffer: new ContentBuffer(m, s, generation) };
}

const codexCases = [
  { type: 'commandExecution', status: 'completed', exitCode: 0, outcome: 'succeeded' },
  { type: 'commandExecution', status: 'completed', exitCode: 7, outcome: 'failed' },
  { type: 'commandExecution', status: 'failed', exitCode: 1, outcome: 'failed' },
  { type: 'commandExecution', status: 'completed', exitCode: null, outcome: 'unknown' },
  { type: 'commandExecution', status: 'declined', outcome: 'declined' },
  { type: 'collabAgentToolCall', tool: 'wait', status: 'interrupted', outcome: 'interrupted' },
  {
    type: 'dynamicToolCall',
    tool: 'inspect',
    status: 'completed',
    success: false,
    outcome: 'failed',
  },
  {
    type: 'dynamicToolCall',
    tool: 'inspect',
    status: 'completed',
    success: true,
    outcome: 'succeeded',
  },
  {
    type: 'mcpToolCall',
    tool: 'lookup',
    status: 'completed',
    result: { content: ['PRIVATE_PAYLOAD'] },
    outcome: 'succeeded',
  },
  {
    type: 'mcpToolCall',
    tool: 'lookup',
    status: 'failed',
    error: { message: 'PRIVATE_PAYLOAD' },
    outcome: 'failed',
  },
  { type: 'fileChange', status: 'completed', outcome: 'succeeded' },
  {
    type: 'imageGeneration',
    status: 'failed',
    failure: { message: 'PRIVATE_PAYLOAD' },
    outcome: 'failed',
  },
  { type: 'imageView', outcome: 'unknown' },
  { type: 'webSearch', outcome: 'unknown' },
];

test('Codex live/history separate native tool lifecycle from exact known or unknown outcome', async () => {
  const f = fixture('codex');
  const items = codexCases.map(({ outcome: _expected, ...item }, index) => ({
    ...item,
    id: `tool-${index}`,
    command: 'PRIVATE_PAYLOAD',
    arguments: { token: 'PRIVATE_PAYLOAD' },
    aggregatedOutput: 'PRIVATE_PAYLOAD',
  }));
  for (const item of items)
    observeCodexContent(f.buffer, f.s.uuid, {
      method: 'item/completed',
      params: { threadId: f.s.uuid, turnId: 'turn-a', item },
    });
  const history = await codexContextApi(f.m, f.s, {
    close() {},
    async request() {
      return { data: items.map((item) => ({ turnId: 'turn-a', item })), nextCursor: null };
    },
  }).history({ limit: 64 }, AbortSignal.timeout(1_000));
  const frame = contentFrame(ContentSnapshotSchema.parse(f.buffer.snapshot()), null);
  expect(frame.baseline).toHaveLength(items.length);
  for (const [index, expected] of codexCases.entries()) {
    const live = frame.baseline[index];
    const stored = history.entries[index];
    expect(live).toMatchObject({ itemId: `tool-${index}`, text: null, complete: true });
    expect(live?.tool).toMatchObject({
      callId: `tool-${index}`,
      name: 'tool' in expected ? expected.tool : expected.type,
      lifecycle: 'completed',
      outcome: expected.outcome,
    });
    expect(stored?.itemId).toBe(live?.itemId);
    // History without a native status cannot infer lifecycle from an item/completed event it never saw.
    if ('status' in expected) expect(stored?.tool).toEqual(live?.tool);
    else expect(stored?.tool).toMatchObject({ lifecycle: 'unknown', outcome: 'unknown' });
  }
  expect(JSON.stringify({ frame, history })).not.toContain('PRIVATE_PAYLOAD');
});

const openCodeCases = [
  { status: 'completed', metadata: { exit: 0 }, outcome: 'succeeded' },
  { status: 'completed', metadata: { exit: 9 }, outcome: 'failed' },
  { status: 'error', metadata: {}, outcome: 'failed' },
  { status: 'error', metadata: { interrupted: true }, outcome: 'interrupted' },
  { status: 'completed', metadata: { timeout: true }, outcome: 'failed' },
  { status: 'completed', metadata: {}, outcome: 'unknown' },
  { status: 'running', metadata: { exit: 0 }, outcome: 'unknown' },
  { status: 'pending', metadata: {}, outcome: 'unknown' },
];

test('OpenCode stream, native history and reconnect retain part/call IDs, tool name and outcomes', async () => {
  const f = fixture('opencode');
  const info = {
    id: 'assistant-a',
    sessionID: 'ses_tools',
    role: 'assistant',
    parentID: 'turn-a',
    time: { created: 1, completed: 2 },
  };
  const observer = new OpenCodeContentObserver(f.buffer, 'ses_tools');
  observer.event({ type: 'message.updated', properties: { info } });
  const parts = openCodeCases.map(({ outcome: _expected, ...state }, index) => ({
    id: `part-${index}`,
    callID: `call-${index}`,
    messageID: info.id,
    sessionID: info.sessionID,
    type: 'tool',
    tool: 'bash',
    state: {
      ...state,
      input: { command: 'PRIVATE_PAYLOAD' },
      output: 'PRIVATE_PAYLOAD',
      error: 'PRIVATE_PAYLOAD',
      metadata: { ...state.metadata, private: 'PRIVATE_PAYLOAD' },
    },
  }));
  const cursor = { generation: f.generation, sequence: f.buffer.snapshot().sequence };
  for (const part of parts) observer.event({ type: 'message.part.updated', properties: { part } });
  const client = createOpencodeClient({
    baseUrl: 'http://native.invalid',
    throwOnError: true,
    fetch: Object.assign(async () => Response.json([{ info, parts }]), {
      preconnect: fetch.preconnect,
    }),
  });
  const history = await openCodeContextApi(f.m, f.s, client).history(
    { limit: 64 },
    AbortSignal.timeout(1_000),
  );
  const snapshot = ContentSnapshotSchema.parse(f.buffer.snapshot());
  const replay = contentFrame(snapshot, cursor);
  const reconnect = contentFrame(snapshot, null);
  expect(replay.records).toHaveLength(parts.length);
  expect(reconnect.baseline).toHaveLength(parts.length);
  for (const [index, expected] of openCodeCases.entries()) {
    const live = replay.records[index];
    expect(live?.tool).toMatchObject({
      name: 'bash',
      callId: `call-${index}`,
      outcome: expected.outcome,
      lifecycle: expected.status === 'error' ? 'completed' : expected.status,
    });
    expect(live?.itemId).toBe(`part-${index}`);
    expect(history.entries[index]?.itemId).toBe(live?.itemId);
    expect(history.entries[index]?.tool).toEqual(live?.tool);
    expect(reconnect.baseline[index]?.tool).toEqual(live?.tool);
  }
  expect(JSON.stringify({ replay, reconnect, history })).not.toContain('PRIVATE_PAYLOAD');
});

test('bounded tool observations do not infer outcome from completion, output text or parent turn', () => {
  const f = fixture('opencode');
  const observer = new OpenCodeContentObserver(f.buffer, 'ses_tools');
  observer.event({
    type: 'message.updated',
    properties: {
      info: {
        id: 'a',
        sessionID: 'ses_tools',
        role: 'assistant',
        parentID: 't',
        time: { created: 1, completed: 2 },
        finish: 'stop',
      },
    },
  });
  observer.event({
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part',
        sessionID: 'ses_tools',
        messageID: 'a',
        type: 'tool',
        tool: 'x'.repeat(129),
        state: { status: 'completed', output: 'Success exit code 0', error: 'Interrupted' },
      },
    },
  });
  expect(f.buffer.snapshot().baseline.at(-1)?.tool).toEqual({
    callId: null,
    name: null,
    lifecycle: 'completed',
    outcome: 'unknown',
    exitCode: null,
  });
  expect(
    ToolObservationSchema.safeParse({
      callId: 'c',
      name: 'bash',
      lifecycle: 'running',
      outcome: 'succeeded',
      exitCode: 0,
    }).success,
  ).toBe(false);
});

test('terminal tool evidence survives duplicate and late incomplete updates and bounded eviction', () => {
  const f = fixture('codex');
  const tool: ToolObservation = {
    callId: 'call',
    name: 'commandExecution',
    lifecycle: 'completed',
    outcome: 'failed',
    exitCode: 7,
  };
  f.buffer.tool('t', 'part', tool);
  const sequence = f.buffer.snapshot().sequence;
  f.buffer.tool('t', 'part', { ...tool, lifecycle: 'running', outcome: 'unknown', exitCode: null });
  f.buffer.tool('t', 'part', { ...tool, name: null, outcome: 'unknown', exitCode: null });
  expect(f.buffer.snapshot().sequence).toBe(sequence);
  expect(f.buffer.snapshot().baseline[0]?.tool).toEqual(tool);
  expect(() => f.buffer.tool('t', 'part', { ...tool, callId: 'another' })).toThrow(
    'changed call identity',
  );
  for (let i = 0; i < 70; i++) f.buffer.text('assistant', 'other', `item-${i}`, 'x', 'replace');
  const evicted = f.buffer.snapshot().sequence;
  f.buffer.tool('t', 'part', { ...tool, lifecycle: 'running', outcome: 'unknown', exitCode: null });
  expect(f.buffer.snapshot().sequence).toBe(evicted);
});

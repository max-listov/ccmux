import { expect, test } from 'bun:test';
import type { ExecutorDelta } from 'stitchkit/agent-executor';
import { NativeProjection } from '../src/agent/claude/native/projection.ts';

const raw = (type: string) => ({ source: 'claude', type });

test('assistant text deltas coalesce into one item per turn in both snapshot and content', () => {
  const calls: unknown[][] = [];
  const projection = new NativeProjection();
  projection.turnId = 'turn-1';
  projection.content = {
    buffer: { text: (...args: unknown[]) => calls.push(args) },
    publish: () => undefined,
  } as never;
  projection.applyDelta({
    type: 'text',
    turnId: 'turn-1',
    itemId: 'msg:0',
    text: 'hello ',
    raw: raw('stream_event/text_delta'),
  });
  projection.applyDelta({
    type: 'text',
    turnId: 'turn-1',
    itemId: 'msg:0',
    text: 'world',
    raw: raw('stream_event/text_delta'),
  });
  expect(projection.items).toHaveLength(1);
  expect(projection.items[0]?.text).toBe('hello world');
  expect(calls).toHaveLength(2);
});

test('tool calls and tool results project start and completion with accurate outcomes', () => {
  const tools: unknown[][] = [];
  const projection = new NativeProjection();
  projection.turnId = 'turn-1';
  projection.content = {
    buffer: { tool: (...args: unknown[]) => tools.push(args) },
    publish: () => undefined,
  } as never;
  projection.applyDelta({
    type: 'tool-call',
    turnId: 'turn-1',
    itemId: 'msg:1',
    callId: 'call-1',
    toolName: 'Bash',
    input: { command: 'ls -la' },
    raw: raw('assistant/tool_use'),
  });
  projection.applyDelta({
    type: 'tool-result',
    turnId: 'turn-1',
    itemId: 'result:call-1',
    callId: 'call-1',
    toolName: 'Bash',
    outcome: 'error',
    output: 'exit 1',
    raw: raw('user/tool_result'),
  });
  expect(projection.items[0]).toMatchObject({
    kind: 'tool',
    stage: 'started',
    tool: 'Bash',
    text: 'Bash: ls -la',
  });
  expect(projection.items[1]).toMatchObject({
    kind: 'tool',
    stage: 'completed',
    tool: 'Bash',
  });
  expect(tools[1]?.[2]).toMatchObject({ lifecycle: 'completed', outcome: 'failed' });
});

test('unhandled executor errors are collected without silently dropping them', () => {
  const projection = new NativeProjection();
  const unhandled: ExecutorDelta = {
    type: 'error',
    turnId: 'turn-1',
    itemId: 'err-1',
    kind: 'unhandled',
    message: 'unknown member',
    raw: raw('some_future_member'),
  };
  projection.applyDelta(unhandled);
  expect(projection.turn.unhandled).toEqual(['some_future_member']);
});

test('context window reset delta forwards resetContext to the content buffer', () => {
  let resets = 0;
  const projection = new NativeProjection();
  projection.content = {
    buffer: {
      resetContext: () => {
        resets += 1;
      },
    },
    publish: () => undefined,
  } as never;
  projection.applyDelta({
    type: 'window',
    turnId: 'turn-1',
    itemId: 'compact:1',
    reset: 'context',
    raw: raw('system/compact_boundary'),
  });
  expect(resets).toBe(1);
});

import { expect, test } from 'bun:test';
import { parse } from '../src/agent/codex/transcript.ts';

const record = (payload: unknown) =>
  JSON.stringify({ type: 'response_item', timestamp: '2026-09-30T00:00:00Z', payload });
const call = record({
  type: 'custom_tool_call',
  call_id: 'call-A',
  name: 'exec',
  input: 'await tools.read({ path: "example.txt" });',
});
const result = record({
  type: 'custom_tool_call_output',
  call_id: 'call-A',
  output: [{ type: 'input_text', text: 'verified output' }, { type: 'input_image' }],
});

test('custom code calls preserve raw input and fold structured output exactly once', () => {
  const messages = parse([call, result], 1);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({
    kind: 'tool_call',
    toolName: 'exec',
    toolCallId: 'call-A',
    rawType: 'custom_tool_call',
    input: 'await tools.read({ path: "example.txt" });',
    done: true,
    resultText: 'verified output [image]',
    doneAt: '2026-09-30T00:00:00Z',
  });
});

test('custom results outside the call window remain readable and unmatched calls stay open', () => {
  expect(parse([call], 12, 6000, undefined, 12)[0]).toMatchObject({
    seq: 12,
    done: false,
    resultText: null,
  });
  expect(parse([result], 13, 6000, undefined, 13)[0]).toMatchObject({
    seq: 13,
    kind: 'tool_result',
    toolCallId: 'call-A',
    text: 'verified output [image]',
  });
});

test('custom errors, text limits and ordinary function calls keep independent identities', () => {
  const messages = parse(
    [
      call,
      record({ type: 'function_call', call_id: 'call-B', name: 'read', arguments: '{"path":"x"}' }),
      record({ type: 'function_call_output', call_id: 'call-B', output: 'ordinary output' }),
      record({
        type: 'custom_tool_call_output',
        call_id: 'call-A',
        output: { success: false, content: [{ type: 'text', text: 'refused action' }] },
      }),
    ],
    1,
    8,
  );
  expect(messages).toHaveLength(2);
  expect(messages[0]).toMatchObject({ done: true, status: 'error', resultText: 'refused …' });
  expect(messages[0]?.input).toBe('await to…');
  expect(messages[1]).toMatchObject({ done: true, status: null, resultText: 'ordinary…' });
});

test('unsupported records do not invent actions, malformed custom input does not crash', () => {
  const messages = parse(
    [
      record({ type: 'unrecognized', input: 'discard' }),
      record({ type: 'custom_tool_call', name: 'x', input: 7 }),
    ],
    1,
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject({ text: 'x', done: false, toolCallId: null });
});

test('a derived index from the preceding parser is rebuilt rather than keeping incomplete tool counts', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { indexTranscript, StoredIndexSchema, transcriptIndexPath } = await import(
    '../src/agent/transcript/transcriptIndex.ts'
  );
  const { UsageStore } = await import('../src/usage/store.ts');
  const root = mkdtempSync('/tmp/ccmux-custom-index-');
  const path = join(root, 'rollout.jsonl');
  const accumulate = (lines: string[]) => ({
    messages: 0,
    user: 0,
    assistant: 0,
    thinking: 0,
    toolCalls: parse(lines, 1).filter((message) => message.kind === 'tool_call').length,
  });
  try {
    writeFileSync(path, `${call}\n${result}\n`);
    expect(indexTranscript(path, 'codex', accumulate)?.stats.toolCalls).toBe(1);
    const store = new UsageStore(transcriptIndexPath(path));
    try {
      const index = store.read('index', StoredIndexSchema);
      if (!index) throw new Error('missing derived index');
      store.write('index', { ...index, version: 1, stats: { ...index.stats, toolCalls: 0 } });
    } finally {
      store.close();
    }
    expect(indexTranscript(path, 'codex', accumulate)?.stats.toolCalls).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

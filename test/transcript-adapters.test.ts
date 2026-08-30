import { expect, test } from 'bun:test';
import { parse as parseClaude } from '../src/agent/claude/transcript.ts';
import { parse as parseCodex } from '../src/agent/codex/transcript.ts';

const L = (o: unknown): string => JSON.stringify(o);

test('claude adapter folds a tool_result into its tool_call (one request→outcome block)', () => {
  const lines = [
    L({
      type: 'assistant',
      uuid: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }],
      },
    }),
    L({
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file.txt' }],
      },
    }),
  ];
  const msgs = parseClaude(lines, 1);
  const calls = msgs.filter((m) => m.kind === 'tool_call');
  expect(calls).toHaveLength(1);
  expect(calls[0]?.done).toBe(true);
  expect(calls[0]?.resultText).toContain('file.txt');
  // the standalone tool_result is absorbed, not emitted separately
  expect(msgs.some((m) => m.kind === 'tool_result')).toBe(false);
});

test('claude adapter surfaces assistant text as a message', () => {
  const msgs = parseClaude(
    [
      L({
        type: 'assistant',
        uuid: 'u1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      }),
    ],
    1,
  );
  expect(msgs).toHaveLength(1);
  expect(msgs[0]?.role).toBe('assistant');
  expect(msgs[0]?.text).toBe('hi there');
});

test("codex adapter parses a response_item message's output_text", () => {
  const msgs = parseCodex(
    [
      L({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
      }),
    ],
    1,
  );
  expect(msgs).toHaveLength(1);
  expect(msgs[0]?.role).toBe('assistant');
  expect(msgs[0]?.text).toBe('hello');
});

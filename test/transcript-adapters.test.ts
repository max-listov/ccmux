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

test('codex reasoning: an encrypted item carries no text, a published summary carries its own', () => {
  const lines = [
    L({
      type: 'response_item',
      timestamp: '2026-09-06T00:00:00Z',
      payload: { type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] },
    }),
    L({
      type: 'response_item',
      timestamp: '2026-09-06T00:00:01Z',
      payload: {
        type: 'reasoning',
        id: 'r2',
        encrypted_content: 'opaque',
        summary: [
          { type: 'summary_text', text: 'Checked the config' },
          { type: 'summary_text', text: 'Then the socket' },
        ],
      },
    }),
  ];
  const thinking = parseCodex(lines, 1).filter((m) => m.kind === 'thinking');
  expect(thinking).toHaveLength(2);
  // The absence is a fact in the field that carries text, not a string a consumer has to recognize.
  expect(thinking[0]?.text).toBeNull();
  expect(thinking[0]?.rawType).toBe('reasoning');
  expect(thinking[1]?.text).toBe('Checked the config\n\nThen the socket');
  expect(parseCodex(lines, 1).some((m) => m.text?.includes('[reasoning]') === true)).toBe(false);
});

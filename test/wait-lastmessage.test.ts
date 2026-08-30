import { expect, test } from 'bun:test';
import { lastAssistantText, parseOpts } from '../src/commands/transcript.ts';
import { parseWaitOpts } from '../src/commands/wait.ts';
import type { TranscriptMessage } from '../src/types.ts';

// `ccmux wait` + `transcript --last-message`: the two gestures an orchestrator makes constantly —
// "tell me when it's done" and "give me the answer" — so they must not need a polling loop or a
// JSON window dug through by hand.

const msg = (over: Partial<TranscriptMessage>): TranscriptMessage => ({
  id: '1',
  seq: 1,
  createdAt: null,
  role: 'assistant',
  kind: 'message',
  text: 'hi',
  title: null,
  toolName: null,
  toolCallId: null,
  status: null,
  rawType: null,
  done: false,
  result: null,
  input: null,
  resultText: null,
  ...over,
});

test('wait: --timeout parses seconds; a bad or missing value keeps the default', () => {
  expect(parseWaitOpts(['--timeout', '30']).timeoutSec).toBe(30);
  expect(parseWaitOpts([]).timeoutSec).toBe(300);
  expect(parseWaitOpts(['--timeout', 'junk']).timeoutSec).toBe(300);
  expect(parseWaitOpts(['--timeout', '-5']).timeoutSec).toBe(300); // non-positive → default
});

test('wait: --quiet / -q for script use', () => {
  expect(parseWaitOpts(['--quiet']).quiet).toBe(true);
  expect(parseWaitOpts(['-q']).quiet).toBe(true);
  expect(parseWaitOpts([]).quiet).toBe(false);
});

test('transcript: --last-message is recognized and independent of --json', () => {
  expect(parseOpts(['--last-message']).lastMessage).toBe(true);
  expect(parseOpts(['--last-message']).json).toBe(false);
  expect(parseOpts(['--json']).lastMessage).toBe(false);
});

test('lastAssistantText takes the newest assistant TEXT, skipping tool calls and results', () => {
  const messages = [
    msg({ text: 'older answer' }),
    msg({ role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: 'ls' }),
    msg({ text: 'the final answer' }),
    msg({ role: 'tool', kind: 'tool_result', text: 'output' }),
  ];
  expect(lastAssistantText(messages)).toBe('the final answer');
});

test('lastAssistantText ignores user turns and thinking; null when there is no answer yet', () => {
  expect(lastAssistantText([msg({ role: 'user', text: 'do the thing' })])).toBeNull();
  expect(lastAssistantText([msg({ kind: 'thinking', text: 'hmm' })])).toBeNull();
  expect(lastAssistantText([])).toBeNull();
});

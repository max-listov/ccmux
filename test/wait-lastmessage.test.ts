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
  image: null,
  usage: null,
  doneAt: null,
  agent: null,
  ...over,
});

test('wait: --timeout parses seconds; a missing one is the default and a bad one is refused', () => {
  expect(parseWaitOpts(['agent-a', '--timeout', '30']).timeoutSec).toBe(30);
  expect(parseWaitOpts(['agent-a']).timeoutSec).toBe(300);
  // Refused, not replaced: a caller that asked for a bound must not silently wait five minutes.
  expect(() => parseWaitOpts(['agent-a', '--timeout', 'junk'])).toThrow(
    "--timeout expects a whole number from 1, got 'junk'",
  );
  expect(() => parseWaitOpts(['agent-a', '--timeout', '0'])).toThrow('--timeout expects');
  expect(() => parseWaitOpts(['agent-a', '--timeout', '-5'])).toThrow("got '-5'");
  expect(() => parseWaitOpts(['agent-a', '--tiemout', '5'])).toThrow("Unknown option '--tiemout'");
  expect(() => parseWaitOpts([])).toThrow('missing argument');
});

test('wait: --quiet / -q for script use', () => {
  expect(parseWaitOpts(['agent-a', '--quiet']).quiet).toBe(true);
  expect(parseWaitOpts(['agent-a', '-q']).quiet).toBe(true);
  expect(parseWaitOpts(['agent-a']).quiet).toBe(false);
  // Forwarded to a peer without the address it was resolved from.
  expect(parseWaitOpts(['host-b:agent-a', '-q', '--timeout', '9']).flagArgs).toEqual([
    '-q',
    '--timeout',
    '9',
  ]);
});

test('transcript: --last-message is recognized and independent of --json', () => {
  expect(parseOpts(['agent-a', '--last-message']).lastMessage).toBe(true);
  expect(parseOpts(['agent-a', '--last-message']).json).toBe(false);
  expect(parseOpts(['agent-a', '--json']).lastMessage).toBe(false);
  // A window is one answer and is served at its documented cap; a search is not capped.
  expect(parseOpts(['agent-a', '--json', '--tail', '5000']).tail).toBe(1000);
  expect(parseOpts(['agent-a', '--grep', 'x', '--tail', '5000']).tail).toBe(5000);
  expect(() => parseOpts(['agent-a', '--json', '--tail', 'abc'])).toThrow('--tail expects');
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

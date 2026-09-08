import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// A spawned agent's story lives beside the session file; the `Agent` call is expected to tell it.

function spawnFixture(opts: { notify: boolean; agentIdle: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'ccmux-subagent-'));
  const sessionPath = join(root, 'session-uuid.jsonl');
  const agentDir = join(root, 'session-uuid', 'subagents');
  mkdirSync(agentDir, { recursive: true });
  const agentLines = [
    L({
      type: 'user',
      uuid: 'a1',
      agentId: 'ab12',
      timestamp: '2026-09-08T03:27:30.958Z',
      message: { role: 'user', content: 'READ-ONLY research' },
    }),
    L({
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-09-08T03:27:40.000Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-opus-5',
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000 },
        content: [{ type: 'tool_use', id: 'inner-1', name: 'Bash', input: { command: 'ls' } }],
      },
    }),
    L({
      type: 'user',
      uuid: 'a3',
      timestamp: '2026-09-08T03:27:41.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'inner-1', content: 'x' }],
      },
    }),
  ];
  if (opts.agentIdle)
    agentLines.push(
      // The same API message streamed as two lines: the first carries a partial count.
      L({
        type: 'assistant',
        uuid: 'a4-partial',
        timestamp: '2026-09-08T03:30:59.000Z',
        message: {
          id: 'msg_2',
          role: 'assistant',
          model: 'claude-opus-5',
          usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 5000 },
          content: [{ type: 'text', text: '# Capability' }],
        },
      }),
      L({
        type: 'assistant',
        uuid: 'a4',
        timestamp: '2026-09-08T03:31:00.873Z',
        message: {
          id: 'msg_2',
          role: 'assistant',
          model: 'claude-opus-5',
          usage: { input_tokens: 2, output_tokens: 275, cache_read_input_tokens: 5000 },
          content: [{ type: 'text', text: '# Capability map\n\nAll done.' }],
        },
      }),
    );
  writeFileSync(join(agentDir, 'agent-ab12.jsonl'), `${agentLines.join('\n')}\n`);
  const lines = [
    L({
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-09-08T03:27:30.922Z',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call-agent',
            name: 'Agent',
            input: {
              subagent_type: 'Explore',
              description: 'Map dsh',
              prompt: 'READ-ONLY research',
            },
          },
        ],
      },
    }),
    L({
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-09-08T03:27:30.950Z',
      toolUseResult: {
        isAsync: true,
        status: 'async_launched',
        agentId: 'ab12',
        description: 'Map dsh',
        resolvedModel: 'claude-opus-5[1m]',
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-agent',
            content: 'Async agent launched successfully. agentId: ab12',
          },
        ],
      },
    }),
    L({
      type: 'assistant',
      uuid: 'u3',
      timestamp: '2026-09-08T03:27:35.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'pwd' } }],
      },
    }),
    L({
      type: 'user',
      uuid: 'u4',
      timestamp: '2026-09-08T03:27:36.500Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-bash', content: '/tmp' }],
      },
    }),
  ];
  if (opts.notify)
    lines.push(
      L({
        type: 'user',
        uuid: 'u5',
        timestamp: '2026-09-08T03:31:00.936Z',
        message: {
          role: 'user',
          content:
            '<task-notification>\n<task-id>ab12</task-id>\n<tool-use-id>call-agent</tool-use-id>\n<status>completed</status>\n<summary>Agent "Map dsh" finished</summary>\n<result>' +
            'R'.repeat(7000) +
            '</result>\n</task-notification>',
        },
      }),
    );
  return { lines, sessionPath };
}

test('claude adapter keeps an async Agent call open while its agent works, and reads the agent beside the session', () => {
  const { lines, sessionPath } = spawnFixture({ notify: false, agentIdle: false });
  const msgs = parseClaude(lines, 1, 6000, undefined, 1, { path: sessionPath });
  const call = msgs.find((m) => m.toolName === 'Agent');
  expect(call?.done).toBe(false);
  expect(call?.result).toBeNull();
  expect(call?.agent).toMatchObject({
    id: 'ab12',
    type: 'Explore',
    description: 'Map dsh',
    model: 'claude-opus-5',
    state: 'running',
    startedAt: '2026-09-08T03:27:30.958Z',
    finishedAt: null,
    toolCalls: 1,
    available: true,
  });
  expect(call?.agent?.usage).toEqual({
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 1000,
    cacheCreationTokens: null,
  });
  // the launch receipt is folded away, not shown as a second record
  expect(msgs.some((m) => m.kind === 'tool_result')).toBe(false);
  // an ordinary folded call now says when it ended
  const bash = msgs.find((m) => m.toolName === 'Bash');
  expect(bash?.done).toBe(true);
  expect(bash?.doneAt).toBe('2026-09-08T03:27:36.500Z');
});

test('claude adapter closes the Agent call on the task notification, with the report and the call id on the notification', () => {
  const { lines, sessionPath } = spawnFixture({ notify: true, agentIdle: true });
  const msgs = parseClaude(lines, 1, 6000, undefined, 1, { path: sessionPath });
  const call = msgs.find((m) => m.toolName === 'Agent');
  expect(call?.done).toBe(true);
  expect(call?.doneAt).toBe('2026-09-08T03:31:00.936Z');
  expect(call?.result).toBe('1 tool call');
  expect(call?.resultText?.startsWith('RRRR')).toBe(true);
  expect(call?.agent).toMatchObject({ state: 'finished', finishedAt: '2026-09-08T03:31:00.936Z' });
  const notice = msgs.find((m) => m.title === 'task-notification');
  expect(notice?.role).toBe('user');
  expect(notice?.toolCallId).toBe('call-agent');
  // the clip still applies to the text; the join survives it because it was read before the clip
  expect(notice?.text?.length).toBe(6001);
});

test('claude adapter treats an agent whose transcript ends on its own answer as finished, even before the notification is in the window', () => {
  const { lines, sessionPath } = spawnFixture({ notify: false, agentIdle: true });
  const msgs = parseClaude(lines, 1, 6000, undefined, 1, { path: sessionPath });
  const call = msgs.find((m) => m.toolName === 'Agent');
  expect(call?.done).toBe(true);
  expect(call?.doneAt).toBe('2026-09-08T03:31:00.873Z');
  expect(call?.resultText).toBe('# Capability map\n\nAll done.');
  expect(call?.agent?.toolCalls).toBe(1);
  expect(call?.agent?.usage?.outputTokens).toBe(295);
});

test('claude adapter without a source path still marks the spawn, and says the agent file was not available', () => {
  const { lines } = spawnFixture({ notify: false, agentIdle: true });
  const msgs = parseClaude(lines, 1);
  const call = msgs.find((m) => m.toolName === 'Agent');
  expect(call?.done).toBe(false);
  expect(call?.agent).toMatchObject({
    id: 'ab12',
    state: 'running',
    available: false,
    usage: null,
  });
});

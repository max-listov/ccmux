import { expect, test } from 'bun:test';
import {
  answersDialog,
  approvalKind,
  declaresDialogs,
  permissionResult,
  questionAnswers,
  SUPPORTED_DIALOG_KINDS,
  sessionRule,
} from '../src/agent/claude/native/permission.ts';

test('a request is classified by what is being decided, not by the tool name', () => {
  expect(approvalKind('Bash')).toBe('command');
  expect(approvalKind('Write')).toBe('file');
  // The class that previously had nowhere to land: a network fetch, a subagent task, an MCP tool.
  expect(approvalKind('WebFetch')).toBe('tool');
  expect(approvalKind('Task')).toBe('tool');
  expect(approvalKind('mcp__something__do')).toBe('tool');
});

test('a refusal always carries a reason, because a bare failure invites a retry', () => {
  const denied = permissionResult('decline', { toolName: 'Bash' });
  expect(denied.behavior).toBe('deny');
  expect(denied.behavior === 'deny' && denied.message).toContain('Bash');
});

test('cancelling is a statement about the turn, not about one tool', () => {
  const cancelled = permissionResult('cancel', { toolName: 'Write' });
  expect(cancelled).toMatchObject({ behavior: 'deny', interrupt: true });
});

test('an acceptance may rewrite the input the tool runs with', () => {
  const allowed = permissionResult('accept', {
    toolName: 'Bash',
    updatedInput: { command: 'ls -la' },
  });
  expect(allowed).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
  // A plain acceptance sends no rewrite rather than an empty one.
  expect(permissionResult('accept', { toolName: 'Bash' })).toEqual({ behavior: 'allow' });
});

test('a session-scoped acceptance carries a standing rule, scoped to this session only', () => {
  // Without the rule the runtime would ask again on the next identical tool call, having reported to
  // the operator that it would not — a failure that is invisible precisely because the tool ran.
  // And the destination matters: the operator answered about THIS conversation, so writing the rule
  // anywhere more durable would answer a question nobody asked.
  const scoped = permissionResult('acceptForSession', { toolName: 'Bash' });
  expect(scoped).toMatchObject({ behavior: 'allow' });
  expect(scoped.behavior === 'allow' && scoped.updatedPermissions).toEqual([
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
  ]);
});

test('answers are keyed by the question text the runtime looks them up by', () => {
  // Keyed by position, an answer silently attaches to the wrong question whenever the order differs
  // — which reads as the model ignoring the operator rather than as a mapping bug.
  const keyed = questionAnswers(
    [{ question: 'Which database?' }, { question: 'Which region?' }],
    ['postgres', 'eu-west'],
  );
  expect(keyed.answers).toEqual({ 'Which database?': 'postgres', 'Which region?': 'eu-west' });
});

test('an ask is answered completely or not at all', () => {
  expect(() => questionAnswers([{ question: 'a' }, { question: 'b' }], ['only-one'])).toThrow();
  // Two identical texts cannot be told apart by the lookup the runtime performs.
  expect(() => questionAnswers([{ question: 'same' }, { question: 'same' }], ['x', 'y'])).toThrow(
    'distinguishable',
  );
});

test('four questions are answerable, because four is what may be asked', () => {
  const four = [{ question: 'a' }, { question: 'b' }, { question: 'c' }, { question: 'd' }];
  expect(Object.keys(questionAnswers(four, ['1', '2', '3', '4']).answers)).toHaveLength(4);
});

test('this host declares no dialog kinds, and answers none', () => {
  // Declaring a kind is a promise to render it: the runtime sends that kind only to clients that
  // declared it, and a declared-but-unrendered dialog parks until a deadline. Declaring nothing is
  // a supported state — the runtime degrades the affected flows instead of blocking on them.
  expect(SUPPORTED_DIALOG_KINDS).toHaveLength(0);
  expect(declaresDialogs()).toBe(false);
  expect(answersDialog('resume_return')).toBe(false);
  expect(answersDialog('some_future_kind')).toBe(false);
});

test('a standing rule never escapes the session it was granted in', () => {
  expect(sessionRule('WebFetch').destination).toBe('session');
});

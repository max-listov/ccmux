import { expect, test } from 'bun:test';
import {
  answersDialog,
  approvalKind,
  declaresDialogs,
  questionAnswers,
  SUPPORTED_DIALOG_KINDS,
  toInteractionReply,
} from '../src/agent/claude/native/permission.ts';

test('a request is classified by what is being decided, not by the tool name', () => {
  expect(approvalKind('Bash')).toBe('command');
  expect(approvalKind('Write')).toBe('file');
  expect(approvalKind('WebFetch')).toBe('tool');
  expect(approvalKind('Task')).toBe('tool');
  expect(approvalKind('mcp__something__do')).toBe('tool');
});

test('operator decisions map cleanly to stitchkit InteractionReply', () => {
  expect(toInteractionReply('accept', { toolName: 'Bash' })).toEqual({
    kind: 'approve',
    scope: 'once',
  });
  expect(
    toInteractionReply('accept', { toolName: 'Bash', updatedInput: { command: 'ls -la' } }),
  ).toEqual({
    kind: 'approve',
    scope: 'once',
    updatedInput: { command: 'ls -la' },
  });
  expect(toInteractionReply('acceptForSession', { toolName: 'Bash' })).toEqual({
    kind: 'approve',
    scope: 'session',
  });
  const denied = toInteractionReply('decline', { toolName: 'Bash' });
  expect(denied).toMatchObject({ kind: 'deny' });
  expect(denied.kind === 'deny' && denied.message).toContain('Bash');
  expect(toInteractionReply('cancel', { toolName: 'Write' })).toMatchObject({
    kind: 'deny',
    interrupt: true,
  });
});

test('answers are keyed by the question text the runtime looks them up by', () => {
  const keyed = questionAnswers(
    [{ question: 'Which database?' }, { question: 'Which region?' }],
    ['postgres', 'eu-west'],
  );
  expect(keyed.answers).toEqual({ 'Which database?': 'postgres', 'Which region?': 'eu-west' });
});

test('an ask is answered completely or not at all', () => {
  expect(() => questionAnswers([{ question: 'a' }, { question: 'b' }], ['only-one'])).toThrow();
  expect(() => questionAnswers([{ question: 'same' }, { question: 'same' }], ['x', 'y'])).toThrow(
    'distinguishable',
  );
});

test('four questions are answerable, because four is what may be asked', () => {
  const four = [{ question: 'a' }, { question: 'b' }, { question: 'c' }, { question: 'd' }];
  expect(Object.keys(questionAnswers(four, ['1', '2', '3', '4']).answers)).toHaveLength(4);
});

test('this host declares no dialog kinds, and answers none', () => {
  expect(SUPPORTED_DIALOG_KINDS).toHaveLength(0);
  expect(declaresDialogs()).toBe(false);
  expect(answersDialog('resume_return')).toBe(false);
  expect(answersDialog('some_future_kind')).toBe(false);
});

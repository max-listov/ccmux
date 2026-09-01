import { expect, test } from 'bun:test';
import { classifySdkMessage } from '../src/agent/claude/native/content.ts';

/**
 * The runtime's message union has dozens of members and grows every release. What is being asserted
 * here is mostly that nothing disappears quietly: an unrecognised member must be reported as
 * unhandled, never swallowed by a default that produces no content and no error.
 */

test('assistant output is content, complete and incremental alike', () => {
  expect(classifySdkMessage('assistant')).toEqual({ kind: 'assistant' });
  // Without incremental output a turn is silent until it ends — the difference between watching a
  // conversation and waiting for one.
  expect(classifySdkMessage('stream_event')).toEqual({ kind: 'assistant' });
});

test('a tool RESULT wears the user role, and must not be read as the operator speaking', () => {
  // There is no separate result member: results come back with the user role. Attributing them to
  // the person would put the runtime's own tool output in their mouth.
  expect(classifySdkMessage('user')).toEqual({ kind: 'tool' });
});

test('a terminal message ends the turn, including a refusal', () => {
  expect(classifySdkMessage('result')).toEqual({ kind: 'terminal' });
  // A refusal is how the turn ended. Classifying it as ordinary output would leave the turn looking
  // unfinished forever.
  expect(classifySdkMessage('model_refusal_fallback')).toEqual({ kind: 'terminal' });
  expect(classifySdkMessage('model_refusal_no_fallback')).toEqual({ kind: 'terminal' });
});

test('an unknown member is reported by name, not silently dropped', () => {
  // The failure this guards against has no symptom: a member added upstream lands in a default,
  // produces nothing, and a conversation is missing part of itself with no error anywhere.
  expect(classifySdkMessage('some_future_member')).toEqual({ unhandled: 'some_future_member' });
  expect(classifySdkMessage('')).toEqual({ unhandled: '' });
});

test('members that are genuinely not conversation say which sort they are', () => {
  // Three different reasons to skip, kept apart because they belong in different places: plumbing
  // nobody reads, diagnostics that belong in the journal, and state changes that add no content.
  expect(classifySdkMessage('control_request')).toEqual({ skip: 'transport' });
  expect(classifySdkMessage('api_retry')).toEqual({ skip: 'diagnostic' });
  expect(classifySdkMessage('conversation_reset')).toEqual({ skip: 'lifecycle' });
});

test('an estimated count is not published as usage', () => {
  // This project's usage fields carry provider-reported counts. Letting an estimate in beside them
  // would make one field mean two different things depending on which runtime filled it in.
  expect(classifySdkMessage('thinking_tokens')).toEqual({ skip: 'diagnostic' });
});

test('the compaction boundary is named as a gap rather than hidden', () => {
  // No content kind fits it, and it still matters: usage after a compaction is not comparable with
  // usage before, so a reader without the boundary sees an unexplained drop.
  expect(classifySdkMessage('compact_boundary')).toEqual({ unhandled: 'compact_boundary' });
});

test('subagent activity is content, and its flattening is a declared loss', () => {
  // Tool observations here carry no parent or agent identity, so nested work cannot be represented
  // as nested. Recording it in the main transcript is the honest option; losing it is not.
  for (const type of ['task_started', 'task_updated', 'task_progress', 'task_notification'])
    expect(classifySdkMessage(type)).toEqual({ kind: 'tool' });
});

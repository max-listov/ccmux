import { expect, test } from 'bun:test';
import { lastModel as claudeLastModel } from '../src/agent/claude/transcript.ts';
import { lastModel as codexLastModel } from '../src/agent/codex/transcript.ts';

const line = (o: unknown): string => JSON.stringify(o);

test('claude: takes the model of the most-recent real assistant turn', () => {
  const lines = [
    line({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-4-8' } }),
    line({ type: 'user', message: { role: 'user', content: 'hi' } }),
    line({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5' } }),
  ];
  expect(claudeLastModel(lines)).toBe('claude-fable-5');
});

test('claude: skips <synthetic> turns and walks back to the last real model', () => {
  const lines = [
    line({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5' } }),
    line({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>' } }),
  ];
  expect(claudeLastModel(lines)).toBe('claude-fable-5');
});

test('claude: ignores model ids that live in non-assistant lines (tool payloads)', () => {
  const lines = [
    line({ type: 'assistant', message: { role: 'assistant', model: 'claude-fable-5' } }),
    // an image-gen tool result carries its own model — must NOT be picked up
    line({ type: 'user', message: { role: 'user', model: 'nano-banana-2', content: 'x' } }),
  ];
  expect(claudeLastModel(lines)).toBe('claude-fable-5');
});

test('claude: null when there is no assistant turn yet / malformed lines', () => {
  expect(claudeLastModel([])).toBeNull();
  expect(claudeLastModel(['not json', ''])).toBeNull();
  expect(claudeLastModel([line({ type: 'user', message: { role: 'user' } })])).toBeNull();
});

test('codex: takes the model from the most-recent turn_context', () => {
  const lines = [
    line({ type: 'session_meta', payload: { model: 'gpt-5.6-old' } }),
    line({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
    line({ type: 'event_msg', payload: { type: 'token_count' } }),
  ];
  expect(codexLastModel(lines)).toBe('gpt-5.6-sol');
});

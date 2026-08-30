import { expect, test } from 'bun:test';
import { prettyModel } from '../src/agent/format.ts';

test('prettyModel formats known families by TRANSFORM, not a lookup table', () => {
  expect(prettyModel('claude-fable-5')).toBe('Fable 5');
  expect(prettyModel('claude-opus-4-8')).toBe('Opus 4.8');
  expect(prettyModel('claude-sonnet-4-5')).toBe('Sonnet 4.5');
  expect(prettyModel('claude-opus-5')).toBe('Opus 5');
});

test('a NEW family the code has never seen renders correctly — the whole point', () => {
  // This is the guard: no whitelist anywhere means a model shipped after this code still shows.
  expect(prettyModel('claude-zephyr-9')).toBe('Zephyr 9');
  expect(prettyModel('claude-mythos-6-2')).toBe('Mythos 6.2');
});

test('an 8-digit snapshot suffix is dropped from the label', () => {
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
});

test("anything that isn't <family>-<numeric-version> falls back to the raw stripped id", () => {
  expect(prettyModel('gpt-5.6-sol')).toBe('gpt-5.6-sol'); // codex id, no claude- prefix, dotted+word
  expect(prettyModel('nano-banana-2')).toBe('nano-banana-2'); // non-numeric middle token
  expect(prettyModel('opus')).toBe('opus'); // bare alias, no version
  expect(prettyModel('claude-opus')).toBe('opus'); // prefix stripped, still no version
});

test('null / empty in → null out (never an invented label)', () => {
  expect(prettyModel(null)).toBeNull();
  expect(prettyModel('')).toBeNull();
  expect(prettyModel('   ')).toBeNull();
});

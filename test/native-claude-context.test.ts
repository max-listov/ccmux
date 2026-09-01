import { expect, test } from 'bun:test';
import { compactBoundary, historyEntry, runtimeProjectsDir } from '../src/context/claude.ts';
import { runtimeCapabilities } from '../src/runtime/capabilities.ts';

/**
 * Context operations for the native Claude mode: what a transcript line means, and where the
 * transcript is. Nothing here drives a runtime.
 */

test('the transcript root is the runtime own, not the machine interactive one', () => {
  // The interactive CLI and this mode are different processes with different configuration.
  // Reading the machine's value would look in a neighbouring directory and report an empty
  // conversation as a complete one.
  expect(runtimeProjectsDir({ CLAUDE_CONFIG_DIR: '/Users/u/.elsewhere' })).toBe(
    '/Users/u/.elsewhere/projects',
  );
  expect(runtimeProjectsDir({})).toMatch(/\/\.claude\/projects$/);
});

test('a compaction boundary is recognised by the record the runtime writes', () => {
  const line = JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: '11111111-1111-4111-8111-111111111111',
  });
  expect(compactBoundary(line)).toBe('11111111-1111-4111-8111-111111111111');
  // Mentioning the word is not being one, and neither is an unparseable line.
  expect(compactBoundary(JSON.stringify({ type: 'user', text: 'compact_boundary' }))).toBeNull();
  expect(compactBoundary('{ not json compact_boundary')).toBeNull();
  expect(compactBoundary(undefined)).toBeNull();
});

test('a transcript entry keeps the verdict the transcript already stated', () => {
  const base = {
    id: 'a',
    seq: 1,
    createdAt: null,
    text: 'hello',
    title: null,
    toolName: null,
    toolCallId: null,
    rawType: null,
    done: true,
    result: null,
    input: null,
    resultText: null,
  };
  expect(
    historyEntry({ ...base, role: 'assistant', kind: 'message', status: null } as never).kind,
  ).toBe('assistant');
  expect(
    historyEntry({ ...base, role: 'assistant', kind: 'thinking', status: null } as never).kind,
  ).toBe('reasoning-summary');
  expect(
    historyEntry({ ...base, role: 'tool', kind: 'tool_result', status: null } as never).kind,
  ).toBe('tool');
  // Re-deriving the verdict here would be a second opinion about a fact the transcript states.
  expect(
    historyEntry({ ...base, role: 'tool', kind: 'tool_result', status: 'error' } as never).status,
  ).toBe('failed');
});

test('rollback stays refused while the three served operations are declared', () => {
  const native = runtimeCapabilities({ agent: 'claude', runtime: 'native' });
  expect(native.history).toBe(true);
  expect(native.compaction).toBe(true);
  expect(native.fork).toBe(true);
  // The runtime will not un-say a conversation; declaring it would break on the first call.
  expect(native.rollback).toBe(false);
});

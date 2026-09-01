import { expect, test } from 'bun:test';
import { nativeContextInfo, nativeContextUsage } from '../src/agent/claude/native/context.ts';

const NOW = Date.parse('2026-09-01T10:00:00.000Z');

/**
 * Context fill measured by the runtime instead of parsed out of a statusline.
 *
 * The distinction the scrape cannot make is the one these assert: a percentage means something
 * different against a model's own window than against a smaller compaction window.
 */

test('a smaller limit than the model own window is named as a policy window', () => {
  const usage = nativeContextUsage(
    { totalTokens: 100_000, maxTokens: 200_000, rawMaxTokens: 1_000_000, percentage: 50 },
    NOW,
  );
  expect(usage.window).toBe('compaction-window');
  expect(usage.limitTokens).toBe(200_000);
  // The model's own limit is kept, so "50% of what" is answerable.
  expect(usage.rawLimitTokens).toBe(1_000_000);
});

test('an equal limit is the model own window', () => {
  const usage = nativeContextUsage(
    { totalTokens: 10, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 0 },
    NOW,
  );
  expect(usage.window).toBe('model-limit');
});

test('a percentage past the window is clamped rather than published as drawn', () => {
  // Exceeding the window is real; a bar drawn past its own edge is not a useful way to say so.
  const usage = nativeContextUsage(
    { totalTokens: 210_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 105 },
    NOW,
  );
  expect(usage.percent).toBe(100);
  expect(usage.usedTokens).toBe(210_000);
});

test('a session that has measured nothing reports nothing, not zero', () => {
  // Zero would read as an empty window; the honest answer is that nobody has asked yet.
  expect(nativeContextInfo(null)).toEqual({
    text: null,
    usedTokens: null,
    limitTokens: null,
    percent: null,
    rawLimitTokens: null,
    window: null,
  });
});

test('the reported shape is the one every other session reports', () => {
  const usage = nativeContextUsage(
    { totalTokens: 300_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: 30 },
    NOW,
  );
  expect(nativeContextInfo({ contextUsage: usage } as never)).toEqual({
    text: '300k/1.0M 30%',
    usedTokens: 300_000,
    limitTokens: 1_000_000,
    percent: 30,
    // The runtime measures both ceilings, and the projection carries both: the same percentage
    // means "room left" against the model limit and "about to be folded" against a narrower one.
    rawLimitTokens: 1_000_000,
    window: 'model-limit',
  });
});

test('a peer session carries its context fill through the fleet slice', async () => {
  const { RemoteSessionSchema } = await import('../src/commands/fleetList.ts');
  // What `list --json` already sends. Dropped before, because this schema did not name the field —
  // so a consumer watching the whole fleet could read context for local sessions only.
  const parsed = RemoteSessionSchema.parse({
    name: 'agent-a',
    context: {
      text: '300k/1.0M 30%',
      usedTokens: 300_000,
      limitTokens: 1_000_000,
      percent: 30,
      rawLimitTokens: 2_000_000,
      window: 'compaction-window',
    },
  });
  expect(parsed.context.percent).toBe(30);
  expect(parsed.context.text).toBe('300k/1.0M 30%');
  // Which ceiling the peer measured against travels too: thirty percent of a compaction window is
  // a different fact from thirty percent of the model's limit, and only the peer knows which.
  expect(parsed.context.window).toBe('compaction-window');
  expect(parsed.context.rawLimitTokens).toBe(2_000_000);
  // An older peer says nothing, and nothing is not zero.
  expect(RemoteSessionSchema.parse({ name: 'agent-b' }).context).toEqual({
    rawLimitTokens: null,
    window: null,
    text: null,
    usedTokens: null,
    limitTokens: null,
    percent: null,
  });
});

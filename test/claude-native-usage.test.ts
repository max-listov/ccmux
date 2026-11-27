import { expect, test } from 'bun:test';
import { NativeProjection, nativeUsageFromTurn } from '../src/agent/claude/native/projection.ts';

test('turn usage sums per-model additive deltas from stitchkit without fabricating absent counters', () => {
  const mapped = nativeUsageFromTurn({
    turnId: 'turn-1',
    modelUsageDelta: {
      a: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 60,
      },
      b: { inputTokens: 5, outputTokens: 3 },
    },
  });
  expect(mapped).toEqual({
    inputTokens: 15,
    outputTokens: 7,
    cachedInputTokens: 100,
    reasoningOutputTokens: null,
    totalTokens: null,
  });
});

test('a genuine zero survives, while absent modelUsageDelta returns null', () => {
  expect(
    nativeUsageFromTurn({
      turnId: 'turn-1',
      modelUsageDelta: { sonnet: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 500 } },
    }),
  ).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 500 });
  expect(nativeUsageFromTurn({ turnId: 'turn-1' })).toBeNull();
});

test('a completed turn reports its per-turn spend into the content stream and keeps terminal usage null', () => {
  const calls: unknown[][] = [];
  const projection = new NativeProjection();
  projection.turnId = 'turn-1';
  projection.content = {
    buffer: { lifecycle: (...args: unknown[]) => calls.push(args) },
    publish: () => undefined,
  } as never;
  projection.applyTurnUsage({
    turnId: 'turn-1',
    modelUsageDelta: { 'claude-x': { inputTokens: 10, outputTokens: 4 } },
  });
  projection.applyDelta({
    type: 'turn-end',
    turnId: 'turn-1',
    itemId: 'turn-1:end',
    outcome: 'completed',
    raw: { source: 'claude', type: 'result' },
  });
  const usage = calls.filter((call) => call[0] === 'usage');
  expect(usage).toHaveLength(1);
  expect(usage[0]?.[1]).toBe('turn-1');
  expect(usage[0]?.[2]).toBe('turn-1:usage');
  expect(JSON.parse(String(usage[0]?.[4]))).toMatchObject({
    scope: 'run',
    inputTokens: 10,
    outputTokens: 4,
  });
  expect(projection.items.filter((item) => item.kind === 'terminal')[0]?.usage).toBeNull();
});

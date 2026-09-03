import { expect, test } from 'bun:test';
import { NativeProjection } from '../src/agent/claude/native/projection.ts';
import { nativeUsage, type SdkModelUsage, turnDelta } from '../src/agent/claude/native/usage.ts';

const usage = (over: Partial<SdkModelUsage> = {}): SdkModelUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...over,
});

test('a turn is what changed, not the running total', () => {
  // Counts accumulate for the life of a streaming session. Publishing the total as the turn's spend
  // inflates every turn after the first, and the error compounds down the conversation.
  const before = { sonnet: usage({ inputTokens: 100, outputTokens: 40 }) };
  const now = { sonnet: usage({ inputTokens: 175, outputTokens: 55 }) };
  expect(turnDelta(now, before)).toMatchObject({ inputTokens: 75, outputTokens: 15 });
});

test('spend across several models is one turn', () => {
  const now = { a: usage({ inputTokens: 10 }), b: usage({ inputTokens: 5, outputTokens: 7 }) };
  expect(turnDelta(now, {})).toMatchObject({ inputTokens: 15, outputTokens: 7 });
});

test('a total that went down is a reset, not a negative turn', () => {
  // A cleared conversation or a freshly resumed session restarts the running count. The honest
  // reading of the next turn is its own absolute spend; a subtraction would report a negative one.
  const before = { a: usage({ inputTokens: 900 }) };
  const now = { a: usage({ inputTokens: 30 }) };
  expect(turnDelta(now, before).inputTokens).toBe(30);
});

test('a genuine zero survives, because the provider did report it', () => {
  // The reference implementation drops zeros to avoid fabricating them. That erases a real
  // measurement: a turn served entirely from cache legitimately spends zero fresh input tokens.
  const mapped = nativeUsage({ reported: true, delta: usage({ cacheReadInputTokens: 500 }) });
  expect(mapped).toMatchObject({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 500 });
});

test('a turn that produced no result reports nothing at all', () => {
  // A crashed or aborted turn carries zeroed counts. Writing them as zero would state a measurement
  // of nothing where there was no measurement.
  expect(nativeUsage({ reported: false })).toBeNull();
  expect(nativeUsage({ reported: false, delta: usage({ inputTokens: 0 }) })).toBeNull();
});

test('counts the SDK does not carry are never invented', () => {
  const mapped = nativeUsage({
    reported: true,
    delta: usage({ inputTokens: 12, outputTokens: 3 }),
  });
  // No counterpart exists; the nearest value the SDK offers is explicitly an estimate.
  expect(mapped?.reasoningOutputTokens).toBeNull();
  // Summing input and output would look like a provider figure and be wrong wherever the provider
  // counts something those two do not cover.
  expect(mapped?.totalTokens).toBeNull();
});

test('cache reads and cache writes are one cached figure', () => {
  const mapped = nativeUsage({
    reported: true,
    delta: usage({ cacheReadInputTokens: 40, cacheCreationInputTokens: 60 }),
  });
  expect(mapped?.cachedInputTokens).toBe(100);
});

test('a completed turn reports its spend as a usage record, like every other runtime', () => {
  // The numbers were never missing on this runtime — they rode on the terminal item, which is not
  // where a consumer scanning for `usage` records looks. Five threads therefore read as free rather
  // than unreported, and "free" is indistinguishable from "not measured" on a spend bar.
  const projection = new NativeProjection();
  projection.turnId = 'turn-1';
  projection.record(
    {
      type: 'result',
      modelUsage: { 'claude-x': { inputTokens: 10, outputTokens: 4 } },
    } as never,
    'terminal',
    false,
  );
  const usage = projection.items.filter((item) => item.kind === 'usage');
  expect(usage).toHaveLength(1);
  expect(usage[0]?.turnId).toBe('turn-1');
  expect(usage[0]?.usage?.inputTokens).toBe(10);
  expect(usage[0]?.usage?.outputTokens).toBe(4);
  // And exactly once: the terminal record no longer carries the same figure, because one number
  // written in two places is two authorities on it.
  const terminal = projection.items.filter((item) => item.kind === 'terminal');
  expect(terminal).toHaveLength(1);
  expect(terminal[0]?.usage).toBeNull();
});

import { expect, test } from 'bun:test';
import { customUsageBody } from '../src/agent/custom/projection.ts';

/**
 * A turn's spend, in the body every runtime writes into the content stream, saying whose spend it
 * is and staying silent about a price nobody named.
 */

const counted = (value: number | null) => ({ value, provenance: 'computed' as const });

test('the body declares the scope of the figure it carries', () => {
  // The number covers ONE run. The codex-shaped body means a session total, and a consumer reading
  // this one as that would be wrong by every earlier turn — so the scope is stated, not inferred.
  const body = customUsageBody({
    inputTokens: counted(10),
    outputTokens: counted(4),
  } as never);
  expect(body).toMatchObject({ scope: 'run', inputTokens: 10, outputTokens: 4, totalTokens: 14 });
});

test('a price appears only when a provider named one', () => {
  const priced = customUsageBody({
    inputTokens: counted(10),
    outputTokens: counted(4),
    cost: { value: 0.002, currency: 'USD', provenance: 'computed' },
  } as never);
  expect(priced).toMatchObject({ costValue: 0.002, costCurrency: 'USD' });

  // A local server prices nothing. Writing zero here would turn "nobody said" into "it cost
  // nothing" — the fabrication the token counts already refuse.
  const unpriced = customUsageBody({
    inputTokens: counted(10),
    outputTokens: counted(4),
    cost: { provenance: 'unavailable' },
  } as never);
  expect(unpriced && 'costValue' in unpriced).toBe(false);
});

test('an absent count stays absent instead of becoming a confident zero', () => {
  const body = customUsageBody({
    inputTokens: counted(null),
    outputTokens: counted(4),
  } as never);
  expect(body).toMatchObject({ inputTokens: null, totalTokens: null });
});

test('a run the harness reported nothing for produces no record at all', () => {
  expect(customUsageBody(undefined)).toBeNull();
});

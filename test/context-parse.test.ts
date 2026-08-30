import { expect, test } from 'bun:test';
import { parseContext, tokNum } from '../src/agent/context.ts';

// The CTX column of `list` / `list --json` is built from this parse of the agent statusline label.

test('tokNum resolves unit suffixes (source of the used/limit token numbers)', () => {
  expect(tokNum('850.0k')).toBe(850_000);
  expect(tokNum('1.0M')).toBe(1_000_000);
  expect(tokNum('1200')).toBe(1200);
  expect(tokNum('2G')).toBe(2_000_000_000);
  expect(tokNum('garbage')).toBeNull();
});

test('parseContext splits used/limit/percent from a full statusline label', () => {
  expect(parseContext('120.0k/1.0M 12%')).toEqual({
    text: '120.0k/1.0M 12%',
    usedTokens: 120_000,
    limitTokens: 1_000_000,
    percent: 12,
  });
});

test('parseContext handles a bare used-only label (no limit / percent)', () => {
  expect(parseContext('40k')).toEqual({
    text: '40k',
    usedTokens: 40_000,
    limitTokens: null,
    percent: null,
  });
});

test('parseContext on null → all-null (unknown is never invented as 0)', () => {
  expect(parseContext(null)).toEqual({
    text: null,
    usedTokens: null,
    limitTokens: null,
    percent: null,
  });
});

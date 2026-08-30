import { expect, test } from 'bun:test';
import { clipWidth, dispWidth, fmtTokens, pad, sliceToWidth, wrapText } from '../src/tui/format.ts';

// TUI window/wrap primitives — pure, and the thing that keeps text inside a bordered box. Wide
// glyphs (emoji, CJK) take 2 columns, so width must be measured in COLUMNS, not string length.

test('dispWidth counts terminal columns, not chars (wide glyphs = 2)', () => {
  expect(dispWidth('abc')).toBe(3);
  expect(dispWidth('🟢')).toBe(2);
  expect(dispWidth('中文')).toBe(4);
});

test('sliceToWidth never exceeds the column budget', () => {
  expect(sliceToWidth('abcdef', 3)).toBe('abc');
  expect(sliceToWidth('🟢🟢🟢', 3)).toBe('🟢'); // 2 cols fit, next would be 4 > 3
  expect(sliceToWidth('x', 0)).toBe('');
});

test('clipWidth appends an ellipsis only when it overflows', () => {
  expect(clipWidth('hello', 10)).toBe('hello');
  expect(clipWidth('hello world', 5)).toBe('hell…');
});

test('wrapText wraps at word boundaries within the width', () => {
  expect(wrapText('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
});

test("wrapText hard-breaks an unbreakable token so it can't spill the border", () => {
  const lines = wrapText('aaaaaaaaaaXX', 4);
  expect(Math.max(...lines.map(dispWidth))).toBeLessThanOrEqual(4);
});

test('wrapText preserves explicit newlines as separate paragraphs', () => {
  expect(wrapText('a\nb', 10)).toEqual(['a', 'b']);
});

test('fmtTokens: k tier truncates (matches the bash %dk), M tier is one decimal', () => {
  expect(fmtTokens(850)).toBe('850');
  expect(fmtTokens(40_000)).toBe('40k');
  expect(fmtTokens(1_999)).toBe('1k'); // k tier truncates, not "2k"
  expect(fmtTokens(1_250_000)).toBe('1.3M'); // M tier: toFixed(1)
});

test('pad fills to width and truncates past it', () => {
  expect(pad('ab', 4)).toBe('ab  ');
  expect(pad('abcdef', 4)).toBe('abcd');
});

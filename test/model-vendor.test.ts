import { describe, expect, test } from 'bun:test';
import { prettyModel } from '../src/inventory/modelName.ts';
import { modelVendor, VENDOR_CELL, vendorGlyph, vendorMark } from '../src/inventory/vendor.ts';

describe('model vendor', () => {
  test('reads the maker out of the id, raw or already prettified', () => {
    for (const id of ['claude-opus-5', 'claude-fable-5-1', 'Opus 5', 'sonnet', 'Haiku 4.5'])
      expect(modelVendor(id)).toBe('anthropic');
    for (const id of ['gpt-5.6-sol', 'gpt-6', 'o3-mini', 'codex-mini', 'openai/gpt-5'])
      expect(modelVendor(id)).toBe('openai');
    expect(modelVendor('deepseek/deepseek-v4.1-flash')).toBe('deepseek');
    expect(modelVendor('gemini-3-pro')).toBe('google');
    expect(modelVendor('google/gemini-3-pro')).toBe('google');
  });

  test('a family that ships next week resolves with no code change', () => {
    expect(modelVendor('claude-mythos-6')).toBe('anthropic');
    expect(modelVendor('gpt-7-turbo')).toBe('openai');
  });

  // Why every row carries `modelId` beside `model`: the display label of an unknown family has
  // had its vendor prefix removed, so only the raw id can still answer who made it.
  test('the raw id keeps a vendor the display label has already lost', () => {
    expect(prettyModel('claude-mythos-6')).toBe('Mythos 6');
    expect(modelVendor(prettyModel('claude-mythos-6'))).toBeNull();
    expect(modelVendor('claude-mythos-6')).toBe('anthropic');
  });

  test('what the id does not say gets no mark — never a guess', () => {
    for (const id of [null, '', '   ', 'llama-4-70b', 'qwen3-max', 'some-internal-build'])
      expect(modelVendor(id)).toBeNull();
    expect(vendorMark('llama-4-70b')).toBeNull();
  });

  test('the cell is reserved even with no mark, so a mixed column stays aligned', () => {
    expect(vendorGlyph('llama-4-70b')).toBe(VENDOR_CELL);
    expect(vendorGlyph(null).length).toBe(1);
    for (const id of ['Opus 5', 'gpt-6', 'deepseek/deepseek-v4', 'gemini-3-pro'])
      expect(vendorGlyph(id).length).toBe(1); // one cell: two would shift every column after it
  });

  test('OpenAI is white, Anthropic carries its own colour', () => {
    expect(vendorMark('gpt-6')?.color).toBe('white');
    expect(vendorMark('Opus 5')?.color).toBe('#D97757');
  });
});

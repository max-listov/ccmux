import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TEXT_LIMIT, detect, parseSession, readSession } from '../src/lib.ts';

const claudeLine = (role: 'user' | 'assistant', text: string, id = role) =>
  JSON.stringify({
    type: role,
    uuid: id,
    timestamp: id,
    message: { role, content: [{ type: 'text', text }] },
  });

test('parseSession block-parses claude lines into normalized messages', () => {
  const lines = [claudeLine('user', 'hi'), claudeLine('assistant', 'hello there')];
  const msgs = parseSession(lines, 'claude').filter((m) => m.kind === 'message');
  expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
  expect(msgs.map((m) => m.text)).toEqual(['hi', 'hello there']);
});

test('readSession reads a file from disk + parses in one call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-lib-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, `${claudeLine('assistant', 'from disk')}\n`);
  const msgs = readSession(path, 'claude').filter((m) => m.kind === 'message');
  expect(msgs.at(-1)?.text).toBe('from disk');
});

test('textLimit is a passthrough — a larger limit keeps more text (needed for full-text indexing)', () => {
  const long = 'x'.repeat(400);
  const lines = [claudeLine('assistant', long)];
  const clipped = parseSession(lines, 'claude', 20).filter((m) => m.kind === 'message');
  const full = parseSession(lines, 'claude', 10000).filter((m) => m.kind === 'message');
  expect(full.at(-1)?.text?.length).toBe(400); // full text preserved for indexing
  expect(clipped.at(-1)?.text?.length ?? 0).toBeLessThan(400); // small limit clips
  expect(DEFAULT_TEXT_LIMIT).toBe(6000); // the default the parser applies when textLimit is omitted
});

test('detect sniffs the agent format from lines (for dead/historical files)', () => {
  expect(detect([claudeLine('user', 'hi')])).toBe('claude');
  expect(detect([JSON.stringify({ type: 'response_item', payload: {} })])).toBe('codex');
  expect(detect([])).toBeNull();
  expect(detect([''])).toBeNull();
});

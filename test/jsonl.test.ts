import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, readJsonl, UNREADABLE } from '../src/util/jsonl.ts';

/**
 * The one reader of append-only files. It must answer exactly what a fresh read of the whole file
 * would — through every way a file changes between two reads — while decoding only what was added.
 */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const file = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-jsonl-'));
  dirs.push(dir);
  return join(dir, 'log.jsonl');
};

let decodes = 0;
const decode = (raw: unknown): number | undefined => {
  decodes++;
  return typeof raw === 'object' && raw !== null && 'n' in raw ? Number(raw.n) : undefined;
};
const strict = { label: 'test log', badLine: 'throw' as const, decode };
const lenient = { label: 'test log', badLine: 'skip' as const, decode };

test('a grown file decodes only what was added', () => {
  const path = file();
  for (const n of [1, 2, 3]) appendJsonl(path, { n });
  expect(readJsonl(path, strict)).toEqual([1, 2, 3]);
  decodes = 0;
  expect(readJsonl(path, strict)).toEqual([1, 2, 3]);
  expect(decodes).toBe(0); // nothing new, nothing decoded
  appendJsonl(path, { n: 4 });
  expect(readJsonl(path, strict)).toEqual([1, 2, 3, 4]);
  expect(decodes).toBe(1);
});

test('a line still being written is not a record yet, and is read once it is whole', () => {
  const path = file();
  appendJsonl(path, { n: 1 });
  appendFileSync(path, '{"n":');
  expect(readJsonl(path, strict)).toEqual([1]);
  appendFileSync(path, '2}\n');
  expect(readJsonl(path, strict)).toEqual([1, 2]);
});

test('a file rewritten in place, or replaced, is decoded again from the start', () => {
  const path = file();
  for (const n of [1, 2]) appendJsonl(path, { n });
  expect(readJsonl(path, strict)).toEqual([1, 2]);
  // Same inode, longer: only the content says it is not the file that was decoded.
  writeFileSync(path, '{"n":7}\n{"n":8}\n{"n":9}\n');
  expect(readJsonl(path, strict)).toEqual([7, 8, 9]);
  const other = `${path}.new`;
  writeFileSync(other, '{"n":5}\n');
  renameSync(other, path);
  expect(readJsonl(path, strict)).toEqual([5]);
  rmSync(path);
  expect(readJsonl(path, strict)).toEqual([]);
});

test('a damaged line is refused or skipped as the store says, and a refusal is not remembered', () => {
  const path = file();
  writeFileSync(path, '{"n":1}\nnot json\n{"n":3}\n');
  expect(() => readJsonl(path, strict)).toThrow('test log:2 — invalid JSON');
  expect(() => readJsonl(path, strict)).toThrow('test log:2 — invalid JSON');
  expect(readJsonl(path, lenient)).toEqual([1, 3]);
  // A hole keeps its place, and its line number, for a reader whose positions are line numbers.
  const holes = readJsonl(path, {
    label: 'test log',
    badLine: 'hole',
    decode: (raw, line) => (raw === UNREADABLE ? `hole@${line}` : `n@${line}`),
  });
  expect(holes).toEqual(['n@1', 'hole@2', 'n@3']);
});

test('records handed out cannot be changed in place', () => {
  const path = file();
  appendJsonl(path, { n: 1 });
  const read = readJsonl(path, { label: 'x', badLine: 'throw', decode: (raw) => raw });
  expect(() => {
    (read[0] as { n: number }).n = 2;
  }).toThrow();
});

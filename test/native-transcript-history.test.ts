import '../src/agent/index.ts';
import { expect, test } from 'bun:test';
import { completeNativeHistory } from '../src/context/nativeTranscriptHistory.ts';
import type { NativeHistoryEntry, NativeHistoryPage } from '../src/context/schema.ts';
import { nativeTranscriptWindow } from '../src/context/transcriptWindow.ts';

const entry = (i: number): NativeHistoryEntry => ({
  turnId: `t${i}`,
  itemId: `i${i}`,
  kind: 'user',
  text: `message ${i}`,
  omittedBytes: 0,
  images: [],
  omittedImages: 0,
  status: 'completed',
  tool: null,
});
const page = (entries: NativeHistoryEntry[], nextCursor: string | null): NativeHistoryPage => ({
  runtime: 'opencode',
  nativeId: 'ses_history',
  revision: 0,
  entries,
  nextCursor,
  completeness: nextCursor === null ? 'complete' : 'more',
  omittedItems: 0,
  omittedBytes: 0,
});
function feed(size: number) {
  const entries = Array.from({ length: size }, (_, i) => entry(i + 1));
  return async (cursor?: string) => {
    const end = cursor === undefined ? entries.length : Number(cursor);
    const start = Math.max(0, end - 64);
    return page(entries.slice(start, end), start === 0 ? null : String(start));
  };
}

test('more than sixteen pages retain absolute positions across append and backward reads', async () => {
  const signal = AbortSignal.timeout(5_000);
  const first = nativeTranscriptWindow(
    'opencode',
    await completeNativeHistory(feed(1_100), signal),
    { tail: 2 },
  );
  expect(first.totalLines).toBe(1_100);
  expect(first.messages.map((item) => [item.id, item.seq])).toEqual([
    ['i1099', 1099],
    ['i1100', 1100],
  ]);
  const entries = await completeNativeHistory(feed(1_101), signal);
  const appended = nativeTranscriptWindow('opencode', entries, {
    tail: 2,
    cursor: first.totalLines,
  });
  expect(appended.messages.map((item) => [item.id, item.seq])).toEqual([['i1101', 1101]]);
  const older = nativeTranscriptWindow('opencode', entries, { tail: 2, before: 77, limit: 2 });
  expect(older.messages.map((item) => item.id)).toEqual(['i75', 'i76']);
});

test('unknown, omitted, contradictory and cyclic pages never become a complete transcript', async () => {
  const bad: NativeHistoryPage[] = [
    { ...page([], null), completeness: 'unknown' },
    { ...page([entry(1)], null), omittedItems: 1 },
    { ...page([], null), completeness: 'more' },
    { ...page([], 'cursor'), completeness: 'complete' },
  ];
  for (const value of bad) {
    await expect(
      completeNativeHistory(async () => value, AbortSignal.timeout(1000)),
    ).rejects.toThrow();
  }
  await expect(
    completeNativeHistory(async () => page([], 'loop'), AbortSignal.timeout(1000)),
  ).rejects.toThrow('cursor does not advance');
});

test('identity drift and overlapping entries fail instead of shifting positions', async () => {
  await expect(
    completeNativeHistory(
      async (cursor) => ({
        ...page([entry(cursor === undefined ? 2 : 1)], cursor === undefined ? 'older' : null),
        revision: cursor === undefined ? 0 : 1,
      }),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('identity changed');
  await expect(
    completeNativeHistory(
      async (cursor) => page([entry(1)], cursor === undefined ? 'older' : null),
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow('repeats an entry');
});

test('bounded memory and cancellation reject without publishing a suffix', async () => {
  await expect(completeNativeHistory(feed(65_537), AbortSignal.timeout(5_000))).rejects.toThrow(
    'exceeds transcript budget',
  );
  const controller = new AbortController();
  let reads = 0;
  await expect(
    completeNativeHistory(async () => {
      reads++;
      controller.abort();
      return page([entry(1)], null);
    }, controller.signal),
  ).rejects.toThrow();
  expect(reads).toBe(1);
});

test('an empty complete conversation and a text-clipped entry remain readable', async () => {
  expect(
    await completeNativeHistory(async () => page([], null), AbortSignal.timeout(1000)),
  ).toEqual([]);
  const value = { ...entry(1), omittedBytes: 100 };
  expect(
    await completeNativeHistory(
      async () => ({ ...page([value], null), omittedBytes: 100 }),
      AbortSignal.timeout(1000),
    ),
  ).toEqual([value]);
});

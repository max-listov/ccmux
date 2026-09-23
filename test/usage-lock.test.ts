import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_STATS,
  indexTranscript,
  transcriptIndexPath,
} from '../src/agent/transcript/transcriptIndex.ts';
import { aggregateUsage } from '../src/usage/aggregate.ts';
import { readUsageFile } from '../src/usage/file.ts';
import { UsageQuerySchema } from '../src/usage/schema.ts';
import { UsageStore } from '../src/usage/store.ts';

const numbered = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `${JSON.stringify({ n: from + i })}\n`).join('');

/** Another process advancing the same index: its write lock, held until released. */
const holdWriteLock = (path: string) => {
  const holder = new Database(path);
  holder.exec('BEGIN IMMEDIATE');
  return () => {
    holder.exec('ROLLBACK');
    holder.close();
  };
};

test('a usage read whose cache another process is writing answers from what is committed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-usage-lock-'));
  try {
    const path = join(dir, 'usage.sqlite');
    const query = UsageQuerySchema.parse({});
    const store = new UsageStore(path);
    try {
      const cold = holdWriteLock(path);
      try {
        // No cache yet and no lock to build one: an honest "still building", not a failure.
        const building = aggregateUsage(store, query);
        expect(building.building).toBe(true);
        expect(building.buckets).toEqual([]);
      } finally {
        cold();
      }
      const warm = aggregateUsage(store, query);
      const release = holdWriteLock(path);
      try {
        expect(aggregateUsage(store, query)).toEqual(warm);
      } finally {
        release();
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage for a transcript another process is indexing is never "accounting unavailable"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-usage-lock-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, numbered(1, 1_000));
    const query = UsageQuerySchema.parse({});
    expect(readUsageFile('host-a:agent-a', path, 'claude', query, true).state).not.toBe('failed');
    appendFileSync(path, numbered(1_001, 5));
    const release = holdWriteLock(transcriptIndexPath(path));
    try {
      const summary = readUsageFile('host-a:agent-a', path, 'claude', query, true);
      expect(summary.state).not.toBe('failed');
      expect(summary.reason).not.toBe('accounting-unavailable');
    } finally {
      release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('usage stays readable while another process holds the index through its commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-usage-lock-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    writeFileSync(path, numbered(1, 1_000));
    const query = UsageQuerySchema.parse({});
    expect(readUsageFile('host-a:agent-a', path, 'claude', query, true).state).not.toBe('failed');
    // A writer committing, or one whose large transaction spilled to disk, holds the file
    // exclusively. A reader that cannot even take a shared lock for that long is the same busy
    // lock as a writer queue, and must not read as "accounting unavailable" either.
    const holder = new Database(transcriptIndexPath(path));
    holder.exec('BEGIN EXCLUSIVE');
    try {
      const summary = readUsageFile('host-a:agent-a', path, 'claude', query, false);
      expect(summary.reason).not.toBe('accounting-unavailable');
      expect(summary.state).not.toBe('failed');
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a usage store is a read, so a writer on the same file does not refuse it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-usage-lock-'));
  try {
    const path = join(dir, 'usage.sqlite');
    new UsageStore(path).close();
    const release = holdWriteLock(path);
    try {
      const store = new UsageStore(path);
      expect(store.revision()).toBe(0);
      store.close();
    } finally {
      release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a transcript whose index another process is advancing answers from the last committed index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccmux-usage-lock-'));
  try {
    const path = join(dir, 'transcript.jsonl');
    // Longer than the head that identifies the file: under it, an append changes the head and the
    // index is rightly treated as describing a different file.
    writeFileSync(path, numbered(1, 1_000));
    expect(indexTranscript(path, 'claude', () => ({ ...EMPTY_STATS }))?.totalLines).toBe(1_000);
    appendFileSync(path, numbered(1_001, 5));
    const release = holdWriteLock(transcriptIndexPath(path));
    try {
      // The committed index is correct up to its own offset; the appended lines are simply not in
      // it yet, which is what a partially advanced index already says.
      const busy = indexTranscript(path, 'claude', () => ({ ...EMPTY_STATS }));
      expect(busy?.totalLines).toBe(1_000);
      expect(busy && busy.indexedBytes < busy.sourceBytes).toBe(true);
    } finally {
      release();
    }
    const advanced = indexTranscript(path, 'claude', () => ({ ...EMPTY_STATS }));
    expect(advanced?.totalLines).toBe(1_005);
    expect(advanced?.indexedBytes).toBe(advanced?.sourceBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

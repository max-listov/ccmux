import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { INDEX_IDLE_MS, pruneTranscriptIndexes } from '../src/agent/transcript/transcriptIndex.ts';
import { CACHE_DIR } from '../src/config/paths.ts';

/**
 * The cache root promises that deleting costs time and nothing else; this holds the other half —
 * that something does delete. Runs in the suite's private cache (test/preload.ts), never the real one.
 */
const DAY = 24 * 60 * 60 * 1000;

test('gone, idle and retired indexes go; one in use or with a live transcript stays', async () => {
  // Its own directory: other tests index transcripts into the suite's cache at the same time, and
  // none of them may be relied on to have created that cache first.
  mkdirSync(CACHE_DIR, { recursive: true });
  const dir = mkdtempSync(join(CACHE_DIR, 'prune-'));
  const now = Date.now();
  const age = (name: string, ms: number) => {
    const t = (now - ms) / 1000;
    utimesSync(join(dir, name), t, t);
  };
  const file = (name: string, ms: number) => {
    writeFileSync(join(dir, name), 'x');
    age(name, ms);
  };
  const index = (name: string, source: string | null, ms: number) => {
    const db = new Database(join(dir, name));
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, body TEXT NOT NULL)');
    if (source !== null)
      db.query('INSERT INTO metadata VALUES (?,?)').run('source', JSON.stringify(source));
    db.close();
    age(name, ms);
  };
  const transcript = join(dir, 'live.jsonl.txt');
  writeFileSync(transcript, '{}\n');

  const old = INDEX_IDLE_MS + 60_000;
  file('idle.sqlite', old);
  file('idle.sqlite-wal', old);
  file('idle.sqlite-shm', old);
  file('fresh.sqlite', 60_000);
  // Advanced recently through its write-ahead log while the main file kept an old stamp.
  file('walonly.sqlite', old);
  file('walonly.sqlite-wal', 60_000);
  file('retired.json', 60_000);
  index('gone.sqlite', join(dir, 'deleted.jsonl'), 2 * DAY);
  index('present.sqlite', transcript, 2 * DAY);
  index('unrecorded.sqlite', null, 2 * DAY);
  // Its transcript is gone, but it was advanced an hour ago: in use, so it is not opened at all.
  index('busy.sqlite', join(dir, 'deleted.jsonl'), 60 * 60 * 1000);

  const result = await pruneTranscriptIndexes(now, dir);
  expect(readdirSync(dir).sort()).toEqual([
    'busy.sqlite',
    'fresh.sqlite',
    'live.jsonl.txt',
    'present.sqlite',
    'unrecorded.sqlite',
    'walonly.sqlite',
    'walonly.sqlite-wal',
  ]);
  expect(result.removed).toBe(3);
  expect(existsSync(join(dir, 'idle.sqlite-shm'))).toBe(false);
});

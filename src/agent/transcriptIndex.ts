import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CACHE_DIR } from '../config/paths.ts';
import { TranscriptStatsSchema } from '../config/schema.ts';
import type { TranscriptStats } from '../types.ts';
import { parseUsageRecord } from '../usage/normalize.ts';
import type { UsageFact } from '../usage/schema.ts';
import { UsageStore } from '../usage/store.ts';
import { rec } from './normalize.ts';

/**
 * Where a transcript's lines are, so reading the last hundred does not cost the whole file.
 *
 * `transcript --json --tail 120` read 239 MB to answer with 48 KB, and took three seconds doing it —
 * on a machine where a consumer asks eight sessions at once and gives up after twelve. The reason
 * was not the tail: a tail reader already exists and says so in its own comment. It was the LINE
 * NUMBERS. The `--cursor` contract is absolute, a tail read cannot say which line it landed on, so
 * the only reader that could answer was the one that reads everything.
 *
 * So the numbers get their own home. A transcript is append-only, which is the whole reason this can
 * be cheap: the offsets already computed stay true, and each call scans only what was added since.
 * The first call on an old file still pays for it once; every later call pays for the delta.
 *
 * It lives in the cache root deliberately. Everything here is derivable from the file it describes,
 * so deleting it costs time and nothing else — which is exactly the contract that root declares.
 */

/** Lines between checkpoints. 512 keeps the stored index small (a 120k-line transcript is 235
 *  offsets) while bounding a seek to at most that many lines of over-read. */
export const CHECKPOINT_LINES = 512;
/** Read granularity while scanning forward. Large enough that a 239 MB first pass is sequential.
 *  Exported so a test can place a multi-byte character exactly on the boundary. */
export const SCAN_CHUNK = 4 * 1024 * 1024;
/** How much of the head identifies the file. A transcript that was replaced rather than appended to
 *  has a different beginning, and its old offsets would point into the middle of other records. */
const HEAD_BYTES = 4096;

export const StoredIndexSchema = z
  .object({
    version: z.literal(1),
    /** Whose parser produced `stats`. A session that changed runtime must not inherit them. */
    agent: z.string().min(1).max(64),
    head: z.string().length(64),
    identity: z.string(),
    mtime: z.number(),
    observedAt: z.iso.datetime(),
    observedSize: z.int().nonnegative(),
    readOffset: z.int().nonnegative(),
    pending: z.string(),
    skipping: z.boolean(),
    malformed: z.int().nonnegative(),
    context: z.object({ model: z.string().nullable(), epoch: z.string() }),
    /** Bytes indexed. Always ends immediately after a newline, so a record still being written is
     *  outside the index rather than half inside it. */
    size: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    /** Byte offset of the first line of every `CHECKPOINT_LINES`-th block; `[0]` is line 1. */
    checkpoints: z.array(z.number().int().nonnegative()),
    stats: TranscriptStatsSchema,
  })
  .strict();
type StoredIndex = z.infer<typeof StoredIndexSchema>;

export const EMPTY_STATS: TranscriptStats = {
  messages: 0,
  user: 0,
  assistant: 0,
  toolCalls: 0,
  thinking: 0,
};

export const transcriptIndexPath = (path: string): string =>
  join(CACHE_DIR, 'transcript-index', `${createHash('sha256').update(path).digest('hex')}.sqlite`);

function headDigest(fd: number, size: number): string {
  const buffer = Buffer.alloc(Math.min(HEAD_BYTES, size));
  if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, 0);
  return createHash('sha256').update(buffer).digest('hex');
}

function loadStored(
  store: UsageStore,
  agent: string,
  head: string,
  size: number,
  identity: string,
  mtime: number,
): StoredIndex | null {
  const stored = store.read('index', StoredIndexSchema);
  if (!stored) return null;
  // A file that shrank, or whose beginning changed, is not the file this index describes. Reusing
  // it would seek to offsets that now land inside other records — silently, and only for the reader
  // unlucky enough to be looking at that part of the conversation.
  if (
    stored.agent !== agent ||
    stored.head !== head ||
    stored.readOffset > size ||
    stored.identity !== identity ||
    (stored.observedSize === size && stored.mtime !== mtime)
  )
    return null;
  return stored;
}

/** Everything a read needs to answer with absolute line numbers, without a full pass. */
export interface TranscriptIndex {
  totalLines: number;
  stats: TranscriptStats;
  indexedBytes: number;
  sourceBytes: number;
  /** Absolute inclusive line range, 1-based. Returns exactly the lines that exist in it. */
  read(from: number, to: number): string[];
}

/**
 * Bring the index up to the file's current end, then answer from it.
 *
 * `accumulate` is the caller's parser: it is handed each batch of NEW lines exactly once, in file
 * order, and returns what they add to the running totals. Stats are counted here rather than
 * recomputed because recomputing them is the same full pass this exists to avoid — and it was being
 * paid on every call, by a cache that lives in a process that handles one command and exits.
 */
export function indexTranscript(
  path: string,
  agent: string,
  accumulate: (lines: string[]) => TranscriptStats,
  maxBytes = Number.MAX_SAFE_INTEGER,
): TranscriptIndex | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  let store: UsageStore | undefined;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const size = stat.size;
    const head = headDigest(fd, size);
    store = new UsageStore(transcriptIndexPath(path));
    const owner = store;
    const identity = `${stat.dev}:${stat.ino}`;
    const index = owner.transaction(() => {
      const stored = loadStored(owner, agent, head, size, identity, stat.mtimeMs);
      if (!stored) owner.reset();
      const index: StoredIndex = stored ?? {
        version: 1,
        agent,
        head,
        identity,
        mtime: stat.mtimeMs,
        observedAt: new Date().toISOString(),
        observedSize: size,
        readOffset: 0,
        pending: '',
        skipping: false,
        malformed: 0,
        context: { model: null, epoch: head },
        size: 0,
        lines: 0,
        checkpoints: [0],
        stats: { ...EMPTY_STATS },
      };
      const oldOffset = index.readOffset;
      if (index.readOffset < size)
        scanForward(fd, index, Math.min(size, oldOffset + maxBytes), accumulate, owner);
      index.observedSize = size;
      index.mtime = stat.mtimeMs;
      if (!stored || index.readOffset !== oldOffset) {
        index.observedAt = new Date().toISOString();
        owner.write('index', index);
      }
      return index;
    });
    return {
      totalLines: index.lines,
      stats: index.stats,
      indexedBytes: index.readOffset,
      sourceBytes: size,
      read: (from, to) => readRange(path, index, from, to),
    };
  } finally {
    store?.close();
    closeSync(fd);
  }
}

/**
 * Scan the bytes added since the last pass, counting lines and checkpointing every so often.
 *
 * Streamed rather than collected: the first pass over a 239 MB transcript would otherwise hold the
 * whole thing as strings to count four numbers. `pending` carries the fragment across a chunk
 * boundary, and the scan stops at the last newline — a record still being appended is not a line
 * yet, and indexing it would put an offset in the middle of a record that is about to grow.
 */
function scanForward(
  fd: number,
  index: StoredIndex,
  size: number,
  accumulate: (lines: string[]) => TranscriptStats,
  store: UsageStore,
): void {
  let offset = index.readOffset;
  // Bytes, not a string: a chunk boundary can fall inside a multi-byte character, and decoding each
  // fragment separately turns it into two replacement characters. Transcripts here are mostly not
  // ASCII, so that is the common case rather than the exotic one.
  let pending: Buffer[] = index.pending ? [Buffer.from(index.pending, 'base64')] : [];
  let pendingBytes = pending.reduce((n, b) => n + b.length, 0);
  let batch: string[] = [];
  const flush = () => {
    if (batch.length === 0) return;
    const observedAt = new Date().toISOString();
    for (const raw of batch) {
      if (!raw.trim()) continue;
      let fact: UsageFact | null = null;
      try {
        const entry = rec(JSON.parse(raw));
        if (!entry) {
          index.malformed++;
          continue;
        }
        fact = parseUsageRecord(index.agent, entry, index.context, observedAt);
      } catch {
        index.malformed++;
      }
      if (fact) store.put(fact);
    }
    const added = accumulate(batch);
    index.stats = {
      messages: index.stats.messages + added.messages,
      user: index.stats.user + added.user,
      assistant: index.stats.assistant + added.assistant,
      toolCalls: index.stats.toolCalls + added.toolCalls,
      thinking: index.stats.thinking + added.thinking,
    };
    batch = [];
  };
  while (offset < size) {
    const length = Math.min(SCAN_CHUNK, size - offset);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    if (read <= 0) break;
    offset += read;
    let from = 0;
    for (let at = 0; at < read; at++) {
      if (buffer[at] !== 0x0a) continue;
      // The byte just after the newline is where the next line starts, and therefore the only
      // offset a checkpoint may hold.
      const tail = buffer.subarray(from, at);
      if (!index.skipping)
        batch.push(
          pending.length === 0
            ? tail.toString('utf8')
            : Buffer.concat([...pending, tail]).toString('utf8'),
        );
      else index.malformed++;
      const lineEnd = offset - read + at + 1;
      pending = [];
      pendingBytes = 0;
      index.skipping = false;
      index.lines += 1;
      index.size = lineEnd;
      if (index.lines % CHECKPOINT_LINES === 0) index.checkpoints.push(lineEnd);
      from = at + 1;
      if (batch.length >= 4096) flush();
    }
    if (from < read && !index.skipping) {
      pendingBytes += read - from;
      if (pendingBytes > 16 * 1024 * 1024) {
        pending = [];
        index.skipping = true;
      } else pending.push(Buffer.from(buffer.subarray(from, read)));
    }
  }
  flush();
  index.readOffset = offset;
  index.pending = Buffer.concat(pending).toString('base64');
}

/** Read one absolute line range by seeking to the checkpoint at or before it. */
function readRange(path: string, index: StoredIndex, from: number, to: number): string[] {
  const first = Math.max(1, from);
  const last = Math.min(index.lines, to);
  if (last < first || index.lines === 0) return [];
  const block = Math.floor((first - 1) / CHECKPOINT_LINES);
  const start = index.checkpoints[block] ?? 0;
  const startLine = block * CHECKPOINT_LINES + 1;
  // Read to the checkpoint that begins after the range, so the bytes pulled are bounded by the
  // range plus at most one block — not by whatever remains of the file.
  const endBlock = Math.floor(last / CHECKPOINT_LINES) + 1;
  const end = index.checkpoints[endBlock] ?? index.size;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return [];
  }
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(first - startLine, last - startLine + 1);
  } finally {
    closeSync(fd);
  }
}

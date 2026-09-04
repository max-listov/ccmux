import { existsSync, readFileSync, watch } from 'node:fs';
import type { z } from 'zod';
import { chatLedgerPath, outboxPath } from '../config/paths.ts';
import { CHAT_GENERATION } from '../config/schema.ts';
import { OutboundSchema } from '../fleet/outbox.ts';
import type { MachineConfig } from '../types.ts';
import type { LogFrame, LogRow } from './feedSchema.ts';

export { type LogFrame, LogFrameSchema } from './feedSchema.ts';

import { rowFromLedgerRecord, rowFromOutbound } from './fleetLog.ts';
import { parseRecord } from './store.ts';

/**
 * The chat log as a resumable feed instead of a snapshot you take again and again.
 *
 * `chat log --json` answers "what is there now". A live surface needs "what changed", and the
 * difference is not cosmetic: polling a tail means every consumer re-serialises the whole history it
 * already has, and one message long enough to push that document past a transport's cap makes the
 * JSON unparseable — not partly readable, unreadable, because a truncated document has no last
 * brace. A stream of bounded records cannot fail that way at all.
 *
 * ## The cursor is a POSITION, never a timestamp
 *
 * The session event feed resumes on an instant, and that is right for it: its records are stamped by
 * one writer on one clock, and duplicates at the boundary are dropped by `id`.
 *
 * Nothing of the sort holds here. Both sources are append-only files whose rows carry the timestamp
 * of the machine that MINTED the message, so a fleet view legitimately contains rows whose order and
 * whose clocks disagree; many messages share a second; and a corrected clock can move a later record
 * behind an earlier one. A time cursor under any of those either replays what the consumer has or —
 * worse, and silently — skips what it has not.
 *
 * A position cannot do either. Both files are append-only and never rewritten, so record N is record
 * N forever, and "everything after N" is exact. The generation rides along because that is precisely
 * when positions DO move: a new record generation retires the old file to the archive, and a cursor
 * from before that retirement describes a file this one no longer is. Refusing it is the whole
 * difference between resuming and quietly reading someone else's history.
 */

/** Where a reader got to, in each of the two append-only files this feed reads. */
export interface LogCursor {
  /** The record generation these positions belong to. Positions are meaningless across a retirement. */
  gen: number;
  /** Records consumed from the chat ledger. */
  ledger: number;
  /** Records consumed from the outbox. */
  outbox: number;
}

export const ZERO_CURSOR: LogCursor = { gen: CHAT_GENERATION, ledger: 0, outbox: 0 };

export const formatCursor = (c: LogCursor): string => `${c.gen}.${c.ledger}.${c.outbox}`;

export type CursorParse = { cursor: LogCursor } | { error: string };

/**
 * Read a cursor back, refusing anything this build cannot honour.
 *
 * A cursor is only ever handed back by this same producer, so a malformed one is a defect somewhere
 * and must be loud. The quiet alternative — ignore it and start from "now" — is the one failure with
 * no symptom: the stream opens, records flow, and everything from the gap simply does not exist for
 * that consumer.
 */
export function parseCursor(raw: string): CursorParse {
  const parts = raw.split('.');
  if (parts.length !== 3) return { error: `expected <generation>.<ledger>.<outbox>, got '${raw}'` };
  const [gen = Number.NaN, ledger = Number.NaN, outbox = Number.NaN] = parts.map((p) =>
    Number.parseInt(p, 10),
  );
  if (
    !Number.isInteger(gen) ||
    !Number.isInteger(ledger) ||
    !Number.isInteger(outbox) ||
    ledger < 0 ||
    outbox < 0
  ) {
    return { error: `expected three non-negative integers, got '${raw}'` };
  }
  if (gen !== CHAT_GENERATION) {
    return {
      error:
        `cursor is for record generation ${gen}, this log is generation ${CHAT_GENERATION}. ` +
        `Positions do not survive a generation change — start without a cursor to read the current log.`,
    };
  }
  return { cursor: { gen, ledger, outbox } };
}

/**
 * The largest frame this feed will emit.
 *
 * Anchored to the transport rather than chosen by taste: the remote transport carries a stream in 32 KiB chunks,
 * so a record that fits inside one is never split across two, and a reader assembling lines never
 * has to hold a partial record across a chunk boundary. The cap is on the WHOLE frame, not on the
 * body alone — otherwise a long address or task name could still push a frame over while the field
 * everyone watches looked innocent.
 */
export const MAX_FRAME_BYTES = 32 * 1024;

/**
 * A frame guaranteed to fit, with an oversized record REPLACED rather than cut.
 *
 * Truncating JSON is the failure this feed exists to remove: a cut document is not partly readable,
 * it is unreadable, and the reader learns nothing about why. So an outsized record is emitted whole
 * and honest — its route, its time and its position are all intact — with the body swapped for a
 * sentence naming the size and where to read the real thing. The record keeps its place in the
 * stream, so the cursor still advances and nothing after it is lost.
 */
export function boundFrame(frame: LogFrame): LogFrame {
  const size = Buffer.byteLength(JSON.stringify(frame));
  if (size <= MAX_FRAME_BYTES || frame.kind !== 'row') return frame;
  const bytes = Buffer.byteLength(frame.row.body);
  return {
    ...frame,
    row: {
      ...frame.row,
      body: `(body omitted: ${bytes} bytes exceeds this feed's ${MAX_FRAME_BYTES}-byte record limit — read it with: ccmux chat log -n 1 --json)`,
      note: frame.row.note === '' ? 'oversized' : `${frame.row.note}; oversized`,
    },
  };
}

const rowFrame = (row: LogRow, cursor: LogCursor): LogFrame =>
  boundFrame({ kind: 'row', cursor: formatCursor(cursor), row });

export const machineFrame = (
  machine: string,
  cursor: LogCursor,
  ok = true,
  error: string | null = null,
): LogFrame => ({
  kind: 'machine',
  cursor: formatCursor(cursor),
  machine: { machine, ok, error },
});

/** Lines of an append-only file from `from` onward, with the count actually consumed. Missing file =
 *  nothing yet, which is a normal state on a machine that has never chatted. */
function linesAfter(path: string, from: number): { lines: string[]; next: number } {
  if (!existsSync(path)) return { lines: [], next: from };
  let all: string[];
  try {
    all = readFileSync(path, 'utf8').split('\n');
  } catch {
    return { lines: [], next: from };
  }
  // A trailing newline yields an empty last element, and a line still being written has no newline
  // yet — both are excluded by taking only complete lines.
  const complete = all.slice(0, -1);
  return { lines: complete.slice(from), next: Math.max(from, complete.length) };
}

/**
 * Everything after the cursor, in position order: the ledger first, then the outbox.
 *
 * NOT interleaved by time, and that is deliberate. Ordering by clock is what the snapshot does for a
 * person reading a story, and it is the wrong contract for a resumable stream — two rows sharing a
 * second would have no defined order, and a corrected clock would move a row behind one the consumer
 * already has. Position order is total, stable and the same on every read, which is what a cursor
 * needs to mean anything. A consumer that wants chronology sorts what it has; it cannot recover a
 * position it was never told.
 */
export function rowsAfter(
  m: MachineConfig,
  cursor: LogCursor,
  settled: ReadonlySet<string> = new Set(),
): { frames: LogFrame[]; cursor: LogCursor } {
  const frames: LogFrame[] = [];
  const ledger = linesAfter(chatLedgerPath(m), cursor.ledger);
  let at: LogCursor = { ...cursor };
  for (const [i, line] of ledger.lines.entries()) {
    at = { ...at, ledger: cursor.ledger + i + 1 };
    if (line.trim() === '') continue;
    let record: ReturnType<typeof parseRecord>;
    try {
      record = parseRecord(JSON.parse(line), 'chat feed');
    } catch {
      record = null; // unreadable here; the row says so rather than the position disappearing
    }
    frames.push(rowFrame(rowFromLedgerRecord(m.rcPrefix, record), at));
  }
  at = { ...at, ledger: Math.max(at.ledger, ledger.next) };

  const outbox = linesAfter(outboxPath(m), cursor.outbox);
  for (const [i, line] of outbox.lines.entries()) {
    at = { ...at, outbox: cursor.outbox + i + 1 };
    if (line.trim() === '') continue;
    let parsed: z.infer<typeof OutboundSchema> | undefined;
    try {
      parsed = OutboundSchema.safeParse(JSON.parse(line)).data;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) continue; // the outbox is bookkeeping, not history — a bad line is skipped
    frames.push(rowFrame(rowFromOutbound(m.rcPrefix, parsed, settled), at));
  }
  at = { ...at, outbox: Math.max(at.outbox, outbox.next) };
  return { frames, cursor: at };
}

/**
 * Watch both files and emit what appears after the cursor.
 *
 * The DIRECTORY is watched rather than the files: either may not exist yet on a machine that has
 * never chatted, and a watch on a missing path is not a watch at all. A slow timer stands behind it
 * because filesystem events are advisory — dropped under load, absent over some mounts — and a feed
 * that silently stops is worse than one that is a second late.
 */
export function followRows(
  m: MachineConfig,
  from: LogCursor,
  onFrame: (frame: LogFrame) => void,
  opts: { intervalMs?: number } = {},
): () => void {
  let cursor = from;
  const settled = new Set<string>();
  const drain = (): void => {
    const next = rowsAfter(m, cursor, settled);
    cursor = next.cursor;
    for (const frame of next.frames) onFrame(frame);
  };
  drain();
  const watchers = [chatLedgerPath(m), outboxPath(m)].map((p) => {
    try {
      return watch(p.slice(0, p.lastIndexOf('/')), () => drain());
    } catch {
      return null;
    }
  });
  const timer = setInterval(drain, opts.intervalMs ?? 2_000);
  return () => {
    clearInterval(timer);
    for (const w of watchers) w?.close();
  };
}

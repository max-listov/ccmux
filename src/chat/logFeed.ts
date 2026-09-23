import { watch } from 'node:fs';
import { chatLedgerPath, outboxPath } from '../config/paths.ts';
import { OutboundSchema } from '../fleet/outbox.ts';
import type { MachineConfig } from '../types.ts';
import type { LogFrame, LogRow } from './feedSchema.ts';
import { CHAT_GENERATION } from './messageSchema.ts';

export { type LogFrame, LogFrameSchema } from './feedSchema.ts';

import { readJsonl, UNREADABLE } from '../util/jsonl.ts';
import { rowFromLedgerRecord, rowFromOutbound } from './fleetLog.ts';
import { type LedgerSlot, parseRecord } from './ledger.ts';

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
  const bounded: LogFrame = {
    ...frame,
    row: {
      ...frame.row,
      body: `(body omitted: ${bytes} bytes exceeds this feed's ${MAX_FRAME_BYTES}-byte record limit — read it with: ccmux chat log -n 1 --json)`,
      note: frame.row.note === '' ? 'oversized' : `${frame.row.note}; oversized`,
    },
  };
  if (Buffer.byteLength(JSON.stringify(bounded)) <= MAX_FRAME_BYTES) return bounded;
  // Never truncate a verbatim quote into different evidence. Keep the full claim on disk and
  // explicitly report its omission in this bounded projection.
  const {
    communicationAuthorization: omitted,
    communicationReceipt: omittedReceipt,
    ...row
  } = bounded.row;
  return {
    ...bounded,
    row: {
      ...row,
      note: `${row.note}; communication authorization omitted from feed — read the source ledger by messageId`,
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

/**
 * The two files as the feed reads them: every line keeps its number, because a position in the feed is
 * a line number and a consumer resumes from it. A ledger line this build cannot read stays as a hole
 * — the row says so rather than the position disappearing; an outbox line that does not parse is
 * bookkeeping, not history, and is skipped.
 */
const FEED_LEDGER = {
  label: 'chat ledger',
  badLine: 'hole',
  decode: (raw: unknown, line: number): { line: number; record: LedgerSlot } => {
    try {
      return { line, record: raw === UNREADABLE ? null : parseRecord(raw, 'chat feed') };
    } catch {
      return { line, record: null };
    }
  },
} as const;

const FEED_OUTBOX = {
  label: 'outbox',
  badLine: 'skip',
  decode: (raw: unknown, line: number) => {
    const parsed = OutboundSchema.safeParse(raw).data;
    return parsed === undefined ? undefined : { line, parsed };
  },
} as const;

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
  let at: LogCursor = { ...cursor };
  for (const { line, record } of readJsonl(chatLedgerPath(m), FEED_LEDGER)) {
    if (line <= cursor.ledger) continue;
    at = { ...at, ledger: line };
    frames.push(rowFrame(rowFromLedgerRecord(m.rcPrefix, record), at));
  }
  for (const { line, parsed } of readJsonl(outboxPath(m), FEED_OUTBOX)) {
    if (line <= cursor.outbox) continue;
    at = { ...at, outbox: line };
    frames.push(rowFrame(rowFromOutbound(m.rcPrefix, parsed, settled), at));
  }
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

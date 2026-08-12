import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";

// Byte-level jsonl line readers, shared by every layer that touches transcript files
// (agent adapters, TUI discover, fork detection). Transcripts grow to tens of MB, so the
// hot paths never read whole files — only a head slice or a tail window.

/** Exact full read (line numbers preserved). Only for paths that NEED absolute numbers
 *  (the `transcript --cursor` contract); everything hot goes through the windows below. */
export function readLines(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const TAIL_CHUNK = 512 * 1024;

/** Default ceiling for one tail read. A line cap alone does not bound cost: cost is bytes,
 *  and a record's size is the agent's business, not ours. Transcripts exist in the wild whose
 *  lines run to six figures of bytes, where "the last 2000 lines" means "well over a gigabyte,
 *  concatenated and decoded into one string". Every read is therefore capped by BOTH. */
export const DEFAULT_TAIL_BYTES = 512 * 1024;

/** Ladder for readTailUntil: start small, widen only while a fact is still missing. The top
 *  rung is the point past which we would rather report an unknown model than freeze the UI. */
export const TAIL_BUDGETS: readonly number[] = [512 * 1024, 4 * 1024 * 1024];

/** Read just the last `maxLines` lines, and never more than `maxBytes` — the hot paths (list
 *  row, TUI pane, CTX fallback) only ever parse a tail window, so reading the whole file each
 *  poll tick was the dominant I/O cost of the entire app. Pulls 512KB slices from the file end
 *  until enough newlines are seen OR the byte budget is spent; newline counting is byte-level
 *  (0x0A never occurs inside a UTF-8 multi-byte char) and decoding happens once over the joined
 *  buffer, so slice borders can't split chars. Absolute line NUMBERS are lost — the
 *  `transcript --cursor` contract keeps going through readLines (exact, full read). */
export function readTailLines(path: string, maxLines: number, maxBytes: number = DEFAULT_TAIL_BYTES): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const budget = Math.max(1, maxBytes);
  // The whole file fits in one chunk AND in the budget → read it outright, line numbers intact.
  if (size <= TAIL_CHUNK && size <= budget) {
    const lines = readLines(path);
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  }
  const floor = Math.max(0, size - budget);
  const fd = openSync(path, "r");
  const slices: Buffer[] = [];
  try {
    let start = size;
    let newlines = 0;
    // maxLines+1 newlines: the first line of a mid-file window is dropped as possibly partial.
    while (start > floor && newlines <= maxLines) {
      const from = Math.max(floor, start - TAIL_CHUNK);
      const buf = Buffer.alloc(start - from);
      readSync(fd, buf, 0, buf.length, from);
      slices.unshift(buf);
      start = from;
      for (const byte of buf) if (byte === 10) newlines++;
    }
    const lines = Buffer.concat(slices).toString("utf8").split("\n");
    // A window that starts mid-file opens on a partial record — drop it. This is also why a
    // budget-truncated window can come back empty: one record larger than the whole budget.
    if (start > 0) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  } finally {
    closeSync(fd);
  }
}

/** Read a tail window that grows only while `satisfied` still reports something missing.
 *  Facts like "which model" or "how many tokens" ride recent records, so the first rung
 *  answers almost every call; the ladder exists for the rare transcript where it doesn't,
 *  and it STOPS rather than walking back through the whole file. */
export function readTailUntil(
  path: string,
  maxLines: number,
  satisfied: (lines: string[]) => boolean,
  budgets: readonly number[] = TAIL_BUDGETS,
): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  let lines: string[] = [];
  for (const budget of budgets) {
    lines = readTailLines(path, maxLines, budget);
    // Stop on the answer, or once the window already spans the entire file — a wider
    // budget past that point re-reads the same bytes and cannot reveal anything new.
    if (satisfied(lines) || budget >= size) return lines;
  }
  return lines;
}

/** First `bytes` of the file as lines, without reading the whole (multi-MB) transcript.
 *  The last line of the slice may be cut mid-record — callers JSON.parse defensively. */
export function readHeadLines(path: string, bytes: number): string[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.toString("utf8", 0, n).split("\n");
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

/** Read one complete first JSONL record without loading the rest of a multi-MB rollout. */
export function readFirstLine(path: string, maxBytes = 2 * 1024 * 1024): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < maxBytes) {
      const size = Math.min(64 * 1024, maxBytes - offset);
      const buf = Buffer.alloc(size);
      const n = readSync(fd, buf, 0, size, offset);
      if (n === 0) break;
      const slice = buf.subarray(0, n);
      const newline = slice.indexOf(10);
      chunks.push(newline === -1 ? slice : slice.subarray(0, newline));
      if (newline !== -1) return Buffer.concat(chunks).toString("utf8");
      offset += n;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

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

/** Read just the last `maxLines` lines — the hot paths (list row, TUI pane, CTX fallback)
 *  only ever parse a tail window, so reading the whole file each poll tick was the dominant
 *  I/O cost of the entire app. Pulls 512KB slices from the file end until enough newlines
 *  are seen; newline counting is byte-level (0x0A never occurs inside a UTF-8 multi-byte
 *  char) and decoding happens once over the joined buffer, so slice borders can't split
 *  chars. Absolute line NUMBERS are lost — the `transcript --cursor` contract keeps going
 *  through readLines (exact, full read). */
export function readTailLines(path: string, maxLines: number): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size <= TAIL_CHUNK) {
    const lines = readLines(path);
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  }
  const fd = openSync(path, "r");
  const slices: Buffer[] = [];
  try {
    let start = size;
    let newlines = 0;
    // maxLines+1 newlines: the first line of a mid-file window is dropped as possibly partial.
    while (start > 0 && newlines <= maxLines) {
      const from = Math.max(0, start - TAIL_CHUNK);
      const buf = Buffer.alloc(start - from);
      readSync(fd, buf, 0, buf.length, from);
      slices.unshift(buf);
      start = from;
      for (const byte of buf) if (byte === 10) newlines++;
    }
    const lines = Buffer.concat(slices).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.length > maxLines ? lines.slice(-maxLines) : lines;
  } finally {
    closeSync(fd);
  }
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

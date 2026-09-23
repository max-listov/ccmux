import { statSync } from 'node:fs';
import type { TranscriptMessage } from '../types.ts';
import { readTailUntil } from '../util/readLines.ts';

/** What a provider's transcript reader offers for summarising a session from the end of its file. */
export interface TailReader {
  parse: (lines: string[], startLine: number, textLimit: number) => TranscriptMessage[];
  lastModel: (lines: string[]) => string | null;
  usedTokens: (lines: string[]) => number | null;
}

/**
 * What an external session was last doing, from the end of its transcript.
 *
 * Bounded in bytes, not just lines: records can be large enough that a fixed line window once meant
 * reading gigabytes to display a model name. The last message dates the activity; a transcript with
 * no dated message falls back to the file's own modification time.
 */
export function readExternalTail(path: string, maxLines: number, reader: TailReader) {
  const tail = readTailUntil(
    path,
    maxLines,
    (lines) => reader.lastModel(lines) !== null && reader.usedTokens(lines) !== null,
  );
  const lastMessage = reader.parse(tail.slice(-120), 1, 280).at(-1) ?? null;
  const parsedTime = lastMessage?.createdAt ? Date.parse(lastMessage.createdAt) : Number.NaN;
  let lastActivityMs: number | null = Number.isFinite(parsedTime) ? parsedTime : null;
  if (lastActivityMs === null) {
    try {
      lastActivityMs = statSync(path).mtimeMs;
    } catch {
      lastActivityMs = null;
    }
  }
  return {
    tail,
    lastActivityMs,
    lastModel: reader.lastModel(tail),
    usedTokens: reader.usedTokens(tail),
    lastMessage,
  };
}

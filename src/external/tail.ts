import { statSync } from 'node:fs';
import {
  FAST_TAIL_LINES,
  LAST_MESSAGE_TEXT_LIMIT,
  tailActivityFromMessages,
} from '../agent/transcript/activity.ts';
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
 * reading gigabytes to display a model name. The last real conversation message dates the activity,
 * widening across the already-read tail when trailing bookkeeping exceeds the 120-line fast slice;
 * a transcript with no dated message falls back to the file's own modification time.
 */
export function readExternalTail(path: string, maxLines: number, reader: TailReader) {
  const tail = readTailUntil(
    path,
    maxLines,
    (lines) => reader.lastModel(lines) !== null && reader.usedTokens(lines) !== null,
  );
  const fast = tailActivityFromMessages(
    reader.parse(tail.slice(-FAST_TAIL_LINES), 1, LAST_MESSAGE_TEXT_LIMIT),
  );
  const activity =
    fast.lastActivityMs === null && tail.length > FAST_TAIL_LINES
      ? tailActivityFromMessages(reader.parse(tail, 1, LAST_MESSAGE_TEXT_LIMIT))
      : fast;
  let lastActivityMs = activity.lastActivityMs;
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
    lastMessage: activity.lastMessage,
  };
}

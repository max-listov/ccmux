import { existsSync, statSync } from 'node:fs';
import type { AgentKind, TranscriptMessage, TranscriptStats } from '../types.ts';
import type { AgentProvider } from './index.ts';
import { EMPTY_STATS, indexTranscript } from './transcriptIndex.ts';

type TranscriptParser = Pick<AgentProvider, 'id' | 'parse'>;

export function unavailableTranscript(
  agent: AgentKind,
  path: string,
  error: string,
): TranscriptRead {
  return {
    agent,
    available: false,
    error,
    path,
    totalLines: 0,
    messages: [],
    mtimeMs: null,
    firstLine: 1,
    reachedStart: true,
    stats: EMPTY_STATS,
  };
}

/** Whole-session composition, kept as a running total by the transcript index. It used to be
 *  recomputed by re-parsing the whole file behind an in-memory mtime cache — in a process that
 *  handles one command and exits, so the cache never once hit and every call paid the full pass. */
/**
 * What a batch of lines adds to the totals.
 *
 * Counted over a slice rather than the file, because the index feeds each new line here exactly
 * once and keeps the running sum. The four counters survive being cut into batches: a tool_result
 * separated from its call is folded into none of them either way, so a boundary changes no number.
 */
function countStats(provider: TranscriptParser, lines: string[]): TranscriptStats {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let thinking = 0;
  for (const msg of provider.parse(lines, 1)) {
    if (msg.kind === 'tool_call') toolCalls++;
    else if (msg.kind === 'thinking') thinking++;
    else if (msg.kind === 'message') {
      if (msg.role === 'user') user++;
      else if (msg.role === 'assistant') assistant++;
    }
  }
  return { messages: user + assistant, user, assistant, toolCalls, thinking };
}

export interface TranscriptRead {
  agent: AgentKind;
  available: boolean;
  error: string | null;
  path: string;
  totalLines: number;
  messages: TranscriptMessage[];
  mtimeMs: number | null;
  // Window bounds for pagination: `firstLine` = absolute line the parse started at,
  // `reachedStart` = that window reaches the very first line (nothing older to load).
  firstLine: number;
  reachedStart: boolean;
  // Whole-session composition (all lines, cached by mtime) — true totals for the header.
  stats: TranscriptStats;
}

/** Shared absolute-line window reader for provider storage, independent of runtime ownership. */
export function readTranscriptFile(
  path: string | null,
  provider: TranscriptParser,
  opts: { tail: number; cursor?: number; before?: number; limit?: number; textLimit?: number },
): TranscriptRead {
  if (!path || !existsSync(path)) {
    return unavailableTranscript(provider.id, path ?? '', 'transcript file not found');
  }
  const index = indexTranscript(path, provider.id, (batch) => countStats(provider, batch));
  if (!index) return unavailableTranscript(provider.id, path, 'transcript file unreadable');
  const total = index.totalLines;
  let start: number;
  let endLine: number | undefined;
  if (opts.before !== undefined && Number.isFinite(opts.before)) {
    const limit = opts.limit !== undefined && Number.isFinite(opts.limit) ? opts.limit : opts.tail;
    endLine = opts.before - 1;
    start = opts.before - limit;
  } else if (opts.cursor !== undefined && Number.isFinite(opts.cursor)) {
    start = opts.cursor + 1;
  } else {
    start = total > opts.tail ? total - opts.tail + 1 : 1;
  }
  start = Math.max(1, start);
  // Only the window is read, and it is read knowing where it starts — which is the whole reason the
  // index exists. `seq` stays the absolute line number a `--cursor` is expressed in.
  const window = index.read(start, endLine ?? total);
  const messages = provider.parse(window, start, opts.textLimit, endLine, start);
  const stats = index.stats;
  let mtimeMs: number | null = null;
  try {
    mtimeMs = Math.floor(statSync(path).mtimeMs);
  } catch {
    mtimeMs = null;
  }
  return {
    agent: provider.id,
    available: true,
    error: null,
    path,
    totalLines: total,
    messages,
    mtimeMs,
    firstLine: start,
    reachedStart: start <= 1,
    stats,
  };
}

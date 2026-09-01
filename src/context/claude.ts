import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { encodeDir } from '../agent/claude/resume.ts';
import { parse } from '../agent/claude/transcript.ts';
import type { MachineConfig, Session, TranscriptMessage } from '../types.ts';
import { boundedHistoryPage, historyCursor } from './history.ts';
import type { NativeContextApi } from './pump.ts';
import type { NativeHistoryEntry } from './schema.ts';

/**
 * Context operations for the native Claude mode.
 *
 * History comes from the runtime's own transcript, which VISION names as the source of truth for a
 * conversation. It is deliberately NOT served from the live content buffer this mode publishes:
 * that buffer is a bounded window over recent items, so paging back through it would answer a
 * question about the conversation with a fact about the window.
 */

/**
 * Where the runtime keeps its transcripts.
 *
 * The machine's `projectsDir` describes where the INTERACTIVE CLI writes, and this mode is a
 * different process with its own configuration — pointing at the machine's value would read a
 * neighbouring directory and report an empty conversation as a complete one. Resolved the way the
 * runtime resolves it, and the file's existence is then checked rather than assumed.
 */
export function runtimeProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return join(
    configured && configured.length > 0 ? configured : join(homedir(), '.claude'),
    'projects',
  );
}

export function nativeTranscriptPath(s: Session, env?: NodeJS.ProcessEnv): string {
  const id = s.nativeSession?.id;
  if (!id) throw new Error('Native context identity is absent');
  return join(runtimeProjectsDir(env), encodeDir(s.dir), `${id}.jsonl`);
}

/** One transcript message as a history entry. Kinds are mapped, never invented. */
export function historyEntry(message: TranscriptMessage): NativeHistoryEntry {
  const kind: NativeHistoryEntry['kind'] =
    message.kind === 'thinking'
      ? 'reasoning-summary'
      : message.kind === 'tool_call' || message.kind === 'tool_result'
        ? 'tool'
        : message.role === 'user' || message.role === 'assistant'
          ? message.role
          : 'other';
  return {
    turnId: message.id,
    itemId: message.id,
    kind,
    text: message.text ?? null,
    omittedBytes: 0,
    images: [],
    // A transcript entry is a record of something that already happened; nothing in it is in flight.
    omittedImages: 0,
    // The parser already decided this: an entry it marked as an error is one, and re-deriving the
    // verdict here would be a second opinion about a fact the transcript states.
    status: message.status === 'error' ? 'failed' : 'completed',
    tool: null,
  };
}

/** The uuid of a compaction boundary on this line, or null when the line is not one. */
export function compactBoundary(raw: string | undefined): string | null {
  if (!raw?.includes('compact_boundary')) return null;
  try {
    const entry = JSON.parse(raw) as { uuid?: unknown; subtype?: unknown };
    return entry.subtype === 'compact_boundary' && typeof entry.uuid === 'string'
      ? entry.uuid
      : null;
  } catch {
    return null;
  }
}

/** The cursor is a line offset into the transcript, which is append-only and therefore stable. */
const offsetOf = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  const value = Number.parseInt(cursor, 10);
  if (!Number.isInteger(value) || value < 0)
    throw new AppError('HISTORY_CURSOR', 'Native history cursor is invalid', 409);
  return value;
};

export function claudeContextApi(
  m: MachineConfig,
  s: Session,
  compactTurn: (signal: AbortSignal) => Promise<void>,
  env?: NodeJS.ProcessEnv,
): NativeContextApi {
  const path = nativeTranscriptPath(s, env);
  const lines = (): string[] => {
    if (!existsSync(path))
      // Said rather than answered with an empty page: a conversation whose transcript is not where
      // this build expects it is unknown, not empty, and the two call for different actions.
      throw new AppError('HISTORY_UNAVAILABLE', 'Native transcript is unavailable', 503);
    return readFileSync(path, 'utf8').split('\n');
  };
  return {
    async history(query) {
      const all = lines();
      const from = offsetOf(historyCursor(m, s, query.cursor));
      const entries: NativeHistoryEntry[] = [];
      let line = from;
      // Parsed a line at a time so the cursor is exactly "how far this reader got", which a page
      // built by parsing everything and slicing could not report honestly.
      while (line < all.length && entries.length < query.limit) {
        const boundary = compactBoundary(all[line]);
        if (boundary !== null) {
          // The transcript records a compaction as a system entry with no message content, so the
          // ordinary parser emits nothing for it and the conversation appeared simply to jump. Its
          // own record is what marks it, not a gap the reader is left to infer.
          entries.push({
            turnId: boundary,
            itemId: boundary,
            kind: 'compaction',
            text: null,
            omittedBytes: 0,
            images: [],
            omittedImages: 0,
            status: 'completed',
            tool: null,
          });
          line += 1;
          continue;
        }
        // Exactly one line per step. `parse` takes a 1-based start and an exclusive end, so an end of
        // `line + 2` reads two lines while the cursor advances by one — which duplicated every entry.
        for (const message of parse(all, line + 1, undefined, line + 1))
          entries.push(historyEntry(message));
        line += 1;
      }
      const done = line >= all.length;
      return boundedHistoryPage(
        m,
        s,
        entries,
        done ? null : String(line),
        done ? 'complete' : 'more',
      );
    },
    async compactionMarker() {
      // The runtime's own boundary record, observed in the transcript rather than inferred from a
      // token count dropping — which is what a compaction looks like from outside. The last one
      // wins: a conversation may have been compacted more than once.
      let marker: string | null = null;
      for (const raw of lines()) marker = compactBoundary(raw) ?? marker;
      return marker;
    },
    compact: (signal) => compactTurn(signal),
  };
}

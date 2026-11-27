import { statSync } from 'node:fs';
import type { TranscriptMessage } from '../../types.ts';
import { DEFAULT_TAIL_BYTES, readTailLines, readTailUntil } from '../../util/readLines.ts';

/** Fast tail window: covers the common case where the latest message sits near the file end. */
export const FAST_TAIL_LINES = 120;

/** Bounded ceiling when trailing provider bookkeeping exceeds the fast window. */
export const WIDE_TAIL_LINES = 2000;

/** Display clip used when only the latest message preview / metadata is needed. */
export const LAST_MESSAGE_TEXT_LIMIT = 280;

export type TailMessageParser = (
  lines: string[],
  startLine: number,
  textLimit?: number,
) => TranscriptMessage[];

export interface TailActivity {
  /** Most recent parsed transcript entry (display/step/turn-boundary signal). */
  lastMessage: TranscriptMessage | null;
  /** Epoch ms of the most recent real conversation activity, never bare file mtime. */
  lastActivityMs: number | null;
}

/**
 * The activity timestamp of one parsed transcript entry.
 *
 * A folded `tool_call` absorbs its `tool_result` and records the result's timestamp in `doneAt`
 * while keeping the call's start time in `createdAt`, so the later of the two is when that step
 * actually last moved.
 */
export function messageActivityMs(
  message: Pick<TranscriptMessage, 'createdAt' | 'doneAt'>,
): number | null {
  const created = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
  const done = message.doneAt ? Date.parse(message.doneAt) : Number.NaN;
  const hasCreated = Number.isFinite(created);
  const hasDone = Number.isFinite(done);
  if (hasCreated && hasDone) return Math.max(created, done);
  if (hasDone) return done;
  if (hasCreated) return created;
  return null;
}

/**
 * Whether a parsed transcript entry counts as real conversation activity.
 *
 * Runtime-injected `<task-notification>` user records (for example orphaned background-shell
 * notices emitted at `SessionStart:resume` after a host reboot) are bookkeeping notices rather than
 * conversation turns. If the assistant acts on one, its subsequent turn carries the real timestamp.
 */
export function isConversationActivity(
  message: Pick<TranscriptMessage, 'role' | 'kind' | 'title'>,
): boolean {
  return !(
    message.role === 'user' &&
    message.kind === 'message' &&
    message.title === 'task-notification'
  );
}

/** Extract the latest entry and the latest real conversation timestamp from parsed messages. */
export function tailActivityFromMessages(messages: readonly TranscriptMessage[]): TailActivity {
  const lastMessage = messages.at(-1) ?? null;
  let lastActivityMs: number | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || !isConversationActivity(message)) continue;
    const ms = messageActivityMs(message);
    if (ms !== null) {
      lastActivityMs = ms;
      break;
    }
  }
  return { lastMessage, lastActivityMs };
}

/**
 * Read the latest message and real conversation activity timestamp from a transcript file.
 *
 * Starts with the cheap 120-line / 512 KiB fast window and widens via `readTailUntil` (up to 2000
 * lines / 4 MiB) only when trailing provider bookkeeping (`bridge-session`, `cost-state`,
 * `data-flow-records`, resume notifications) pushes the last real message out of the fast window.
 */
export function readTailActivity(
  path: string,
  parse: TailMessageParser,
  textLimit = LAST_MESSAGE_TEXT_LIMIT,
): TailActivity {
  const fastLines = readTailLines(path, FAST_TAIL_LINES, DEFAULT_TAIL_BYTES);
  const fast =
    fastLines.length === 0
      ? { lastMessage: null, lastActivityMs: null }
      : tailActivityFromMessages(parse(fastLines, 1, textLimit));
  if (fast.lastActivityMs !== null) return fast;

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return fast;
  }
  // When the whole file already fit inside the fast window, widening cannot reveal earlier lines.
  if (size <= DEFAULT_TAIL_BYTES && fastLines.length < FAST_TAIL_LINES) return fast;

  let widened: TailActivity = fast;
  readTailUntil(path, WIDE_TAIL_LINES, (lines) => {
    widened =
      lines.length === 0
        ? { lastMessage: null, lastActivityMs: null }
        : tailActivityFromMessages(parse(lines, 1, textLimit));
    return widened.lastActivityMs !== null;
  });
  return widened;
}

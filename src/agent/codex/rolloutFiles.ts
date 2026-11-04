import { existsSync } from 'node:fs';
import { Glob } from 'bun';

/**
 * The files Codex keeps one thread's history in.
 *
 * A thread starts as `rollout-<time>-<thread>.jsonl`. Codex Desktop splits a long thread: each later
 * file is `rollout-<time>-<thread>_<segment>.jsonl`. Codex compresses finished or idle files to
 * `.jsonl.zst` (the Desktop's earlier segments; the CLI's idle threads). Every file begins with the
 * thread's own `session_meta`. Measured on two hosts on 2026-11-04: 4 split files and 2 compressed
 * on one, 39 compressed single-file threads on the other.
 *
 * This is the one reader of that naming: discovery, correlation, the managed supervisor and the
 * external readers all take it from here.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ROLLOUT_NAME = new RegExp(`^rollout-.*?-(${UUID})(?:_(${UUID}))?\\.jsonl(\\.zst)?$`);

/** One file of a thread. `start` is the UUIDv7 time of the thread (first file) or of the segment,
 *  null when that id carries no time. */
export type CodexRolloutFile = { path: string; start: number | null; compressed: boolean };

export type RolloutName = { thread: string; segment: string | null; compressed: boolean };

export function parseRolloutName(name: string): RolloutName | null {
  const match = ROLLOUT_NAME.exec(name);
  if (!match?.[1]) return null;
  return { thread: match[1], segment: match[2] ?? null, compressed: match[3] !== undefined };
}

/** Milliseconds since the epoch carried by a UUIDv7, or null for any other version. */
export function uuidV7Time(id: string): number | null {
  const hex = id.replaceAll('-', '');
  if (hex.length !== 32 || hex[12] !== '7') return null;
  return Number.parseInt(hex.slice(0, 12), 16);
}

export function rolloutFile(path: string, name: RolloutName): CodexRolloutFile {
  return {
    path,
    start: uuidV7Time(name.segment ?? name.thread),
    compressed: name.compressed,
  };
}

/** Oldest first; a file without a start time sorts by its name. */
export function sortRolloutFiles(files: CodexRolloutFile[]): CodexRolloutFile[] {
  return files.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.path.localeCompare(b.path));
}

/** Every file of one thread under `root`, oldest first; empty when there is none. */
export function codexRolloutFiles(root: string | undefined, thread: string): CodexRolloutFile[] {
  if (!root || !existsSync(root)) return [];
  const files: CodexRolloutFile[] = [];
  for (const path of new Glob(`**/rollout-*-${thread}*.jsonl*`).scanSync({
    cwd: root,
    absolute: true,
  })) {
    const name = parseRolloutName(path.slice(path.lastIndexOf('/') + 1));
    if (name?.thread === thread) files.push(rolloutFile(path, name));
  }
  return sortRolloutFiles(files);
}

/** The file Codex is writing now: the newest uncompressed one. Null when every file is compressed. */
export function currentRolloutFile(files: CodexRolloutFile[]): CodexRolloutFile | null {
  const newest = files.at(-1);
  return newest && !newest.compressed ? newest : null;
}

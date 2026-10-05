import { type BigIntStats, lstatSync, statSync } from 'node:fs';

/**
 * One file's identity and content revision as a comparable string: device, inode, size, nanosecond
 * mtime and ctime, mode and owner. Nanosecond ctime is what catches a rewrite whose mtime was put
 * back; inode catches an atomic replacement. Five modules used to build this each their own way,
 * with different precision, symlink handling and error rules — this is the one.
 */
export function statStamp(stat: BigIntStats, { ctime = true }: { ctime?: boolean } = {}): string {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    ctime ? stat.ctimeNs : '',
    stat.mode,
    stat.uid,
  ].join(':');
}

/**
 * The stamp of `path`, or `'missing'` when it does not exist. `follow: false` stamps a symlink
 * itself rather than its target. `ctime: false` leaves ctime out, for files whose metadata moves
 * without their content (an SQLite database the engine re-opens). Any other error is thrown: an
 * unreadable path is not an unchanged one.
 */
export function fileStamp(
  path: string,
  { follow = true, ctime = true }: { follow?: boolean; ctime?: boolean } = {},
): string {
  const stat = follow
    ? statSync(path, { bigint: true, throwIfNoEntry: false })
    : lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return stat === undefined ? 'missing' : statStamp(stat, { ctime });
}

/**
 * How old a file's last change must be before a stamp of it may stand for its content.
 *
 * Linux file clocks advance in kernel ticks (a few milliseconds), not nanoseconds: two writes in one
 * tick that leave the size and inode alone leave every field of the stamp equal, and a cache keyed
 * on it serves the first write's content for as long as the file stays quiet. This is git's "racy
 * index" problem, and the same answer works: a file changed within this window is read again rather
 * than cached, until it has aged past any tick. Measured on a Linux host, where a cached registry
 * test kept the previous content after an in-place rewrite; macOS clocks hid it.
 */
export const RACY_WINDOW_MS = 50;

/** Whether `stat` is old enough that its stamp may stand for its content (see `RACY_WINDOW_MS`). */
export function settled(stat: BigIntStats, nowMs = Date.now()): boolean {
  return nowMs - Number(stat.ctimeNs / 1_000_000n) > RACY_WINDOW_MS;
}

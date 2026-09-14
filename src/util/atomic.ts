import { chmodSync, renameSync, writeFileSync } from 'node:fs';
import { chmod, rename } from 'node:fs/promises';

/**
 * A name no other write in this process can be using.
 *
 * Process id and milliseconds are not enough, and the gap is not theoretical: two writes to the
 * same path in one millisecond — one loop, one command — chose the same temp name, and the second
 * chmod'd a file the first had already renamed away. The failure surfaces as ENOENT on the temp
 * file, which reads like a disk problem rather than a collision.
 */
let sequence = 0;

/**
 * Write a file atomically: write to a unique temp sibling, then rename over the
 * target. A half-write can never be observed as the live file (used for the
 * sessions file, machine.json, boot units, and the update swap).
 */
export async function atomicWrite(path: string, text: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${sequence++}`;
  await Bun.write(tmp, text);
  // The promise forms, not the sync ones, and for the daemon's sake rather than style: a sync call
  // runs on the event loop, so a filesystem that stalls a rename for seconds froze every schedule,
  // control call and delivery with it — measured on a loaded machine as fifteen seconds inside
  // `rename` on the main thread. The promise forms wait on a pool thread and the loop keeps turning.
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path); // atomic on the same filesystem
}

/** The same guarantee without an await, for callers that are synchronous all the way down. */
export function atomicWriteSync(path: string, text: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${sequence++}`;
  writeFileSync(tmp, text);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
}

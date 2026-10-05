import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic, writeFileAtomicSync } from 'stitchkit/files';

/**
 * Replace a file atomically — stitchkit's `writeFileAtomic`, which owns the guarantees (random
 * staging name created exclusively, mode on the descriptor before the file is visible, fsync,
 * rename, nothing left behind on failure) — creating the parent first, which ccmux's callers rely
 * on and stitchkit deliberately does not do. `mode` defaults to stitchkit's `0o600`: ccmux's state
 * directories are readable by other users of the machine, so a file readable by them is stated,
 * never defaulted.
 */
export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, data, mode === undefined ? {} : { mode });
}

/**
 * Replace a snapshot that is rewritten every few seconds and lives no longer than the process that
 * writes it: a status lease, the monitoring and inventory snapshots, the pane-activity map. Still
 * atomic — a reader sees the old file or the whole new one — but without fsync, because after a
 * crash the file is stale by its own lease or generation whether or not its last bytes reached the
 * disk. Without fsync the write is sub-millisecond, so it is done synchronously: the asynchronous
 * form costs more in I/O-pool wake-ups than the write itself (measured on Linux: 1.2 ms of CPU per
 * durable asynchronous write, 0.4 ms for this).
 */
export function writeEphemeralSnapshot(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, data, { mode, durability: 'none' });
}

/** Copy `from` over `to` so that `to` is only ever the old file or the whole new one, keeping the
 *  source's permission bits. A copy straight over `to` that dies midway leaves half a file — and
 *  for the bundle backup it restores, that half file is the one the daemon must start from. */
export function copyFileAtomic(from: string, to: string): void {
  writeFileAtomicSync(to, readFileSync(from), { mode: statSync(from).mode & 0o777 });
}

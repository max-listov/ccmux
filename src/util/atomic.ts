import { readFileSync, statSync } from 'node:fs';
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

/** Copy `from` over `to` so that `to` is only ever the old file or the whole new one, keeping the
 *  source's permission bits. A copy straight over `to` that dies midway leaves half a file — and
 *  for the bundle backup it restores, that half file is the one the daemon must start from. */
export function copyFileAtomic(from: string, to: string): void {
  writeFileAtomicSync(to, readFileSync(from), { mode: statSync(from).mode & 0o777 });
}

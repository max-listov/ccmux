import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { atomicWrite } from '../util/atomic.ts';

/** A file the release bundle carries inside itself: gzip, base64, and the digest of the bytes. */
export interface PackagedFile {
  data: string;
  sha256: string;
}

export type PackagedInstall = 'written' | 'current';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * Lay a packaged file down at `path`, convergently: a file that already holds the right bytes is
 * left alone, anything else is replaced whole. The digest is checked against the bytes actually
 * produced, so a truncated write or a half-finished rollout is replaced rather than used.
 */
export async function convergePackagedFile(
  artifact: PackagedFile,
  path: string,
  mode: number,
  what: string,
): Promise<PackagedInstall> {
  const bytes = gunzipSync(Buffer.from(artifact.data, 'base64'));
  if (sha(bytes) !== artifact.sha256) throw new Error(`${what} artifact digest differs`);
  if (existsSync(path)) {
    try {
      if (sha(readFileSync(path)) === artifact.sha256) return 'current';
    } catch {
      // unreadable → rewrite it
    }
  }
  await atomicWrite(path, bytes, mode);
  return 'written';
}

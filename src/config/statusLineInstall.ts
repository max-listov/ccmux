import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { atomicWrite } from '../util/atomic.ts';
import { STATUS_LINE_APP } from './paths.ts';
import { STATUS_LINE_ARTIFACT, type StatusLineArtifact } from './statusLineArtifact.ts';

export type StatusLineInstall = 'written' | 'current';

/**
 * Require the packaged status-line program and install it beside the bundle.
 *
 * Convergent, like the shim and the boot unit next to it: a machine that is already correct comes
 * out untouched, and one carrying an older copy is rewritten. The digest is checked against the
 * bytes actually produced, so a truncated write or a half-finished rollout is replaced rather than
 * executed — this file is run on every status refresh, and a broken one would be run thousands of
 * times before anyone read a log.
 */
export async function ensureStatusLineApp(
  artifact: StatusLineArtifact | null = STATUS_LINE_ARTIFACT,
  path: string = STATUS_LINE_APP,
): Promise<StatusLineInstall> {
  if (artifact === null) throw new Error('Required status-line artifact is missing');
  const bytes = gunzipSync(Buffer.from(artifact.data, 'base64'));
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256)
    throw new Error('Status-line artifact digest differs');
  if (existsSync(path)) {
    try {
      if (createHash('sha256').update(readFileSync(path)).digest('hex') === artifact.sha256)
        return 'current';
    } catch {
      // unreadable → rewrite it
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  // JS source is UTF-8, so the text round-trips to exactly the bytes the digest covers.
  await atomicWrite(path, bytes.toString('utf8'), 0o755);
  return 'written';
}

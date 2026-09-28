import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ExclusiveLockError, withExclusiveLock } from 'stitchkit/files';

/** How long a caller waits for a lock before giving up. */
export const LOCK_TIMEOUT_MS = 10_000;
/** How old a lock with no recorded owner must be before it is taken — a claim may be in flight. */
const OWNERLESS_GRACE_MS = 5_000;

/**
 * Run `run` under the exclusive lock at `path` — stitchkit's `withExclusiveLock`, which owns the
 * rules: the lock records its owner with that process's boot and birth; an owner on this machine
 * that is provably gone — another boot, or its pid absent or held by a process born later — is taken
 * over at once, a live, slow, foreign or unidentifiable one never is; a lock with no owner only after
 * the grace; a refusal names the
 * resource and its holder. `signal` is the caller's cancellation, honoured WHILE WAITING: a
 * cancelled request that sat out the whole timeout held its admission slot for ten seconds after
 * its caller was told it was aborted. An abort rejects with the caller's own reason.
 */
export async function withLock<T>(
  path: string,
  run: () => Promise<T>,
  label: string,
  timeoutMs = LOCK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  mkdirSync(dirname(path), { recursive: true });
  try {
    return await withExclusiveLock(path, () => run(), {
      label,
      timeoutMs,
      ownerlessGraceMs: OWNERLESS_GRACE_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (e) {
    if (e instanceof ExclusiveLockError && e.code === 'LOCK_ABORTED' && signal?.aborted)
      throw signal.reason;
    throw e;
  }
}

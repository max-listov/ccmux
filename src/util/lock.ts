import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ExclusiveLockError, withExclusiveLock } from 'stitchkit/files';

/** How long a caller waits for a lock before giving up. */
export const LOCK_TIMEOUT_MS = 10_000;
/** How old a lock with no recorded owner must be before it is taken — a claim may be in flight. */
const OWNERLESS_GRACE_MS = 5_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Bounded migration: before stitchkit's file lock, ccmux locked with a DIRECTORY at the same path
 * (`<lock>/owner.json` holding the pid). A process of the older version — a session's `_run`, a
 * daemon not yet restarted — still takes that form, and the two exclude each other, since each
 * finds the path taken. What the file lock cannot do is clear a directory an older process died
 * holding: to it that is a lock with no owner it can read or unlink, and it would wait on it
 * forever. So a dead one is removed here, by the rule the directory lock used: dead pid → at once;
 * no readable owner → only past the grace. A live one is left, and the wait below outlasts it.
 * Remove once no ccmux older than the file lock runs anywhere.
 */
function retireLegacyDirectoryLock(path: string): void {
  let mtimeMs: number;
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return;
    mtimeMs = st.mtimeMs;
  } catch {
    return;
  }
  let pid: number | null = null;
  try {
    const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8')) as { pid?: unknown };
    if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0)
      pid = owner.pid;
  } catch {
    // No owner, or one that cannot be read: only age decides.
  }
  const abandoned = pid === null ? Date.now() - mtimeMs > OWNERLESS_GRACE_MS : !processAlive(pid);
  if (abandoned) rmSync(path, { recursive: true, force: true });
}

/**
 * Run `run` under the exclusive lock at `path` — stitchkit's `withExclusiveLock`, which owns the
 * rules: the lock records its owner; a dead owner on this machine is taken over at once, a live,
 * slow or foreign one never is; a lock with no owner only after the grace; a refusal names the
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
  retireLegacyDirectoryLock(path);
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

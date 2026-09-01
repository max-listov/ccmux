import { join } from 'node:path';
import { privateRuntimeDirectory } from '../agent/codex/ownedPaths.ts';
import { withDirectoryLock } from '../config/registryLock.ts';
import type { MachineConfig, Session } from '../types.ts';
import { managedRuntimeRoot } from './status.ts';

/**
 * How long a pickup waits for the lock before leaving the turn for the next tick.
 *
 * Short on purpose. A pickup runs inside the process that ALSO serves this session's context
 * operations, and those take the same lock across a real compaction round-trip. The lock is not
 * reentrant, so a pickup that waited the full lock timeout would not merely stall — it would throw,
 * and that throw tears the runtime down. Waiting briefly and coming back is free: the tick that
 * follows is a tenth of a second away, and the turn is still in the mailbox.
 */
const PICKUP_WAIT_MS = 500;

/**
 * Take the admission lock if it is free, and say so rather than throwing if it is not.
 *
 * For the owner's own pickup, where contention is ordinary and failing is not.
 */
export async function tryNativeAdmission(
  m: MachineConfig,
  s: Session,
  run: () => Promise<void>,
): Promise<'done' | 'busy'> {
  const root = managedRuntimeRoot(m, s);
  privateRuntimeDirectory(root);
  let entered = false;
  try {
    await withDirectoryLock(
      join(root, 'admission.lock'),
      async () => {
        entered = true;
        await run();
      },
      'native admission',
      PICKUP_WAIT_MS,
    );
    return 'done';
  } catch (error) {
    // Only a failure to GET the lock is ordinary. Anything the pickup itself threw is the caller's.
    if (entered) throw error;
    return 'busy';
  }
}

/** Shared by provider pickup and control mutations, not a transport-local mutex. */
export function withNativeAdmission<T>(
  m: MachineConfig,
  s: Session,
  run: () => Promise<T>,
): Promise<T> {
  const root = managedRuntimeRoot(m, s);
  privateRuntimeDirectory(root);
  return withDirectoryLock(join(root, 'admission.lock'), run, 'native admission');
}

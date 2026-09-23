import { sessionRegistryLockPath } from '../config/paths.ts';
import type { MachineConfig } from '../types.ts';
import { LOCK_TIMEOUT_MS, withLock } from '../util/lock.ts';

/** Serialize every sessions/pending read-modify-write transaction across ccmux processes. */
export async function withSessionRegistryLock<T>(
  m: MachineConfig,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withLock(sessionRegistryLockPath(m), run, 'session registry', LOCK_TIMEOUT_MS, signal);
}

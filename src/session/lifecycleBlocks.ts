import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { lifecycleBlockPath } from '../config/paths.ts';
import type { LifecycleBlock, MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { compareSemver, VERSION } from '../util/version.ts';
import { loadPendingRows } from './pendingStore.ts';
import { recoverPromotionsUnlocked } from './promotion.ts';
import { loadSessions } from './registry.ts';
import { withSessionRegistryLock } from './registryLock.ts';
import { LifecycleBlockSchema } from './schema.ts';

export function readLifecycleBlock(m: MachineConfig, name: string): LifecycleBlock | null {
  const path = lifecycleBlockPath(m, name);
  if (!existsSync(path)) return null;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return LifecycleBlockSchema.parse(value);
}

export function readLifecycleBlockForSession(
  m: MachineConfig,
  session: Session,
): LifecycleBlock | null {
  const block = readLifecycleBlock(m, session.name);
  if (!block || block.agent !== session.agent) return null;
  if (session.registrationGeneration !== undefined) {
    return block.generation === session.registrationGeneration ? block : null;
  }
  return block.uuid === session.uuid ? block : null;
}

/** The block that stops a ready session, keyed to the identity it has now. */
export function sessionBlock(
  session: Session,
  error: string,
  agent: Session['agent'] = session.agent,
): LifecycleBlock {
  return {
    name: session.name,
    agent,
    uuid: session.uuid,
    ...(session.registrationGeneration === undefined
      ? {}
      : { generation: session.registrationGeneration }),
    error,
    at: new Date().toISOString(),
  };
}

export async function writeLifecycleBlock(m: MachineConfig, block: LifecycleBlock): Promise<void> {
  // Every block says which version judged the session, whoever builds the block.
  const parsed = LifecycleBlockSchema.parse({ ...block, version: VERSION });
  await withSessionRegistryLock(m, async () => {
    await recoverPromotionsUnlocked(m);
    const ready = loadSessions(m).find(
      (session) => session.name === parsed.name && session.agent === parsed.agent,
    );
    const pending = loadPendingRows(m).find(
      (item) => item.session.name === parsed.name && item.session.agent === parsed.agent,
    );
    const matchesReady =
      ready !== undefined &&
      (ready.registrationGeneration !== undefined
        ? parsed.generation === ready.registrationGeneration
        : parsed.uuid === ready.uuid);
    const matchesPending = pending !== undefined && parsed.generation === pending.generation;
    if (!matchesReady && !matchesPending) return;
    const path = lifecycleBlockPath(m, parsed.name);
    mkdirSync(dirname(path), { recursive: true });
    await atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
  });
}

export async function clearLifecycleBlockIfGeneration(
  m: MachineConfig,
  name: string,
  generation: string,
): Promise<void> {
  await withSessionRegistryLock(m, async () => {
    const block = readLifecycleBlock(m, name);
    if (block?.generation !== generation) return;
    const path = lifecycleBlockPath(m, name);
    if (existsSync(path)) unlinkSync(path);
  });
}

/** Explicit user start/restart is the recovery action; the daemon heal clears only a block written
 *  by another ccmux version (`clearBlockOfOlderVersion`), never one of its own version. */
export function clearLifecycleBlock(m: MachineConfig, name: string): void {
  const path = lifecycleBlockPath(m, name);
  if (existsSync(path)) unlinkSync(path);
}

/** Whether `block` was written by a version older than `version` (or before blocks carried one). */
export function blockFromOlderVersion(block: LifecycleBlock, version: string): boolean {
  return block.version === undefined || compareSemver(block.version, version) < 0;
}

/**
 * A block is final for the code that wrote it: an OLDER version may have judged the session by a rule
 * that has since been fixed, and must not leave it stopped. A block of the same or a NEWER version
 * stays — a daemon that lags behind the installed bundle would otherwise clear the newer code's
 * refusal every pass and start the session again, forever. Re-read under the registry lock, so a
 * block written in the meantime stays.
 */
export async function clearBlockOfOlderVersion(
  m: MachineConfig,
  name: string,
  version: string = VERSION,
): Promise<boolean> {
  return withSessionRegistryLock(m, async () => {
    const block = readLifecycleBlock(m, name);
    if (block === null || !blockFromOlderVersion(block, version)) return false;
    unlinkSync(lifecycleBlockPath(m, name));
    return true;
  });
}

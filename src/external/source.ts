import { constants, type Stats } from 'node:fs';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { AppError } from 'stitchkit';
import { loadSessions } from '../session/registry.ts';
import type { MachineConfig } from '../types.ts';
import type { ExternalContentTarget } from './contentSchema.ts';
import { fileIdentity } from './contentSnapshot.ts';
import {
  locateExternalStorage,
  readExternalCodexMetadata,
  validateExternalPath,
} from './storage.ts';

/** The external storage of one exact thread, opened read-only and checked to be the thread's own. */
export type ExternalSource = {
  file: FileHandle;
  stat: Stats;
  path: string;
  root: string;
  /** Files of a split thread before the one opened; they are not part of this read. */
  earlierFiles: number;
};

/** Every external read refuses before it looks: another host, a disabled policy, a managed identity. */
export function authorizeExternalRead(m: MachineConfig, target: ExternalContentTarget): void {
  if (target.machine !== m.rcPrefix)
    throw new AppError('IDENTITY_MISMATCH', {
      message: 'External identity does not belong to this host',
      status: 409,
    });
  if (!m.externalInventory)
    throw new AppError('PERMISSION_DENIED', {
      message: 'External content access is disabled',
      status: 403,
    });
  if (loadSessions(m).some((s) => s.agent === target.provider && s.uuid === target.threadId))
    throw new AppError('IDENTITY_MISMATCH', {
      message: 'Use the managed history contract for this identity',
      status: 409,
    });
}

/**
 * Open the thread's native storage without following links or accepting another user's file.
 * `absent`: no configured root or no file for this thread. `changed`: the path moved between lookup
 * and open. The caller owns the returned handle and closes it.
 */
export async function openExternalSource(
  m: MachineConfig,
  target: ExternalContentTarget,
  signal: AbortSignal,
): Promise<ExternalSource | 'absent' | 'changed'> {
  const configuredRoot = target.provider === 'codex' ? m.codexSessionsDir : m.projectsDir;
  if (!configuredRoot) return 'absent';
  const root = await realpath(configuredRoot);
  const located = await locateExternalStorage(root, target, signal);
  if (located === null) return 'absent';
  const opened = await openExternalPath(root, located.path, target);
  return opened === 'changed' ? opened : { ...opened, earlierFiles: located.earlierFiles };
}

/** Open one located file of the thread: contained in the root, no link, the same user's, and its
 *  own metadata naming the thread (for a compressed file, checked by the caller after decoding). */
export async function openExternalPath(
  root: string,
  path: string,
  target: ExternalContentTarget,
  compressed = false,
): Promise<ExternalSource | 'changed'> {
  await validateExternalPath(root, path);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw new AppError('PERMISSION_DENIED', {
        message: 'External storage is not accessible',
        status: 403,
      });
    if (fileIdentity(await lstat(path), path) !== fileIdentity(stat, path)) {
      await file.close();
      return 'changed';
    }
    // A compressed file's metadata is only readable decompressed; its reader checks it there.
    if (target.provider === 'codex' && !compressed)
      await readExternalCodexMetadata(file, target.threadId);
    return { file, stat, path, root, earlierFiles: 0 };
  } catch (error) {
    await file.close();
    throw error;
  }
}

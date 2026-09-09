import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { getProvider } from '../agent/index.ts';
import { readTranscriptFile, unavailableTranscript } from '../agent/transcriptRead.ts';
import { loadSessions } from '../config/sessions.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import {
  locateExternalStorage,
  readExternalCodexMetadata,
  validateExternalPath,
} from './storage.ts';

/**
 * Where the provider keeps this conversation — including after it has finished with it.
 *
 * Codex MOVES a thread out of `sessions/` into `archived_sessions/` beside it, and the address does
 * not change when it does. Looking only in the live directory therefore answers "transcript file not
 * found" about a conversation that is sitting one directory over: measured on this fleet, 215
 * archived against 61 live on one machine and 14 against 0 on another — so for most exact addresses
 * the answer was wrong, and wrong in the way that reads as "this never existed".
 *
 * Live first, archive second, and never both at once: an address that still has a live file must
 * keep resolving to it, and each hit is validated against the root it was found under rather than a
 * shared one.
 */
async function locateInConfiguredRoots(
  sessionsDir: string,
  machine: string,
  threadId: string,
): Promise<{ root: string; path: string } | null> {
  for (const candidate of [sessionsDir, join(dirname(sessionsDir), 'archived_sessions')]) {
    let root: string;
    try {
      root = await realpath(candidate);
    } catch {
      continue; // a provider that keeps no archive is not an error, it is one less place to look
    }
    const found = await locateExternalStorage(
      root,
      { provider: 'codex', machine, threadId },
      AbortSignal.timeout(10_000),
    );
    if (found) return { root, path: found };
  }
  return null;
}

/** Exact provider identity, never a title, caller path, or request to acquire its writer. */
export async function readExternalTranscript(
  m: MachineConfig,
  threadId: string,
  window: Parameters<typeof readTranscriptFile>[2],
) {
  if (!z.uuid().safeParse(threadId).success) throw new Error('Invalid external Codex thread ID');
  if (loadSessions(m).some((s) => s.agent === 'codex' && s.uuid === threadId))
    throw new Error('Use the managed session address for this identity');
  let path = '';
  let dir = '';
  const missing = () => ({
    dir,
    read: unavailableTranscript('codex', path, 'transcript file not found'),
  });
  if (!m.codexSessionsDir) return missing();
  try {
    const located = await locateInConfiguredRoots(m.codexSessionsDir, m.rcPrefix, threadId);
    if (!located) return missing();
    const { root } = located;
    path = located.path;
    await validateExternalPath(root, path);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new Error('External storage is not accessible');
      dir = (await readExternalCodexMetadata(file, threadId)).cwd ?? '';
      const read = readTranscriptFile(path, getProvider('codex'), window);
      await validateExternalPath(root, path);
      const current = await lstat(path);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size < stat.size)
        throw new Error('External storage changed during read');
      return { dir, read };
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = z.object({ code: z.string() }).safeParse(error);
    if (code.success && code.data.code === 'ENOENT') return missing();
    log.warn({ msg: 'external transcript read unavailable', reason: String(error) });
    return { dir, read: unavailableTranscript('codex', path, 'transcript file unreadable') };
  }
}

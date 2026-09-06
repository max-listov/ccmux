import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
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
    const root = await realpath(m.codexSessionsDir);
    const found = await locateExternalStorage(
      root,
      { provider: 'codex', machine: m.rcPrefix, threadId },
      AbortSignal.timeout(10_000),
    );
    if (!found) return missing();
    path = found;
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

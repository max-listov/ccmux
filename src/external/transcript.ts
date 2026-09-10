import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { getProvider } from '../agent/index.ts';
import { readTranscriptFile, unavailableTranscript } from '../agent/transcriptRead.ts';
import { loadSessions } from '../config/sessions.ts';
import type { AgentKind, MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { ownedClaudeConversations } from './claude.ts';
import type { ExternalContentTarget } from './contentSchema.ts';
import {
  locateExternalStorage,
  readExternalClaudeMetadata,
  readExternalCodexMetadata,
  validateExternalPath,
} from './storage.ts';

const metadataCache = new Map<
  string,
  { identity: string; size: number; mtime: number; threadId: string; dir: string }
>();

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
  candidates: string[],
  machine: string,
  target: Pick<ExternalContentTarget, 'provider' | 'threadId'>,
  signal: AbortSignal,
): Promise<{ root: string; path: string } | null> {
  for (const candidate of candidates) {
    let root: string;
    try {
      root = await realpath(candidate);
    } catch (error) {
      const code = z.object({ code: z.string() }).safeParse(error);
      if (code.success && code.data.code === 'ENOENT') continue;
      throw error;
    }
    const found = await locateExternalStorage(root, { ...target, machine }, signal);
    if (found) return { root, path: found };
  }
  return null;
}

/** Exact provider identity, never a title, caller path, or request to acquire its writer. */
export async function withExternalTranscript<T>(
  m: MachineConfig,
  target: Pick<ExternalContentTarget, 'provider' | 'threadId'>,
  read: (path: string) => T,
  signal?: AbortSignal,
): Promise<
  { source: 'readable'; value: T; dir: string } | { source: 'missing' | 'unreadable'; dir: string }
> {
  const { provider, threadId } = target;
  if (!z.uuid().safeParse(threadId).success) throw new Error('Invalid external thread ID');
  const managed = loadSessions(m);
  if (
    provider === 'claude'
      ? ownedClaudeConversations(managed).has(threadId)
      : managed.some((s) => s.agent === provider && s.uuid === threadId)
  )
    throw new Error('Use the managed session address for this identity');
  let path = '';
  let dir = '';
  const missing = (): { source: 'missing'; dir: string } => ({
    source: 'missing',
    dir,
  });
  const sourceRoot = provider === 'codex' ? m.codexSessionsDir : m.projectsDir;
  if (!sourceRoot) return missing();
  try {
    const bounded = AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]);
    bounded.throwIfAborted();
    const located = await locateInConfiguredRoots(
      provider === 'codex'
        ? [sourceRoot, join(dirname(sourceRoot), 'archived_sessions')]
        : [sourceRoot],
      m.rcPrefix,
      target,
      bounded,
    );
    if (!located) return missing();
    const { root } = located;
    path = located.path;
    await validateExternalPath(root, path);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new Error('External storage is not accessible');
      const identity = `${provider}:${stat.dev}:${stat.ino}`;
      const cached = metadataCache.get(path);
      if (
        cached &&
        cached.identity === identity &&
        cached.threadId === threadId &&
        cached.size === stat.size &&
        cached.mtime === stat.mtimeMs
      )
        dir = cached.dir;
      else {
        const metadata =
          provider === 'codex'
            ? await readExternalCodexMetadata(file, threadId)
            : await readExternalClaudeMetadata(file, threadId);
        dir = metadata.cwd ?? '';
        if (metadataCache.size >= 256)
          metadataCache.delete(metadataCache.keys().next().value ?? '');
        metadataCache.set(path, { identity, size: stat.size, mtime: stat.mtimeMs, threadId, dir });
      }
      const value = read(path);
      await validateExternalPath(root, path);
      const current = await lstat(path);
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size < stat.size)
        throw new Error('External storage changed during read');
      return { source: 'readable', dir, value };
    } finally {
      await file.close();
    }
  } catch (error) {
    signal?.throwIfAborted();
    const code = z.object({ code: z.string() }).safeParse(error);
    if (code.success && code.data.code === 'ENOENT') return missing();
    log.warn({ msg: 'external transcript read unavailable', reason: String(error) });
    return { source: 'unreadable', dir };
  }
}

export async function readExternalTranscript(
  m: MachineConfig,
  target: { provider: AgentKind; threadId: string },
  window: Parameters<typeof readTranscriptFile>[2],
) {
  const { provider, threadId } = target;
  if (provider !== 'codex' && provider !== 'claude')
    return {
      dir: '',
      read: unavailableTranscript(provider, '', 'external transcript provider is unsupported'),
    };
  const result = await withExternalTranscript(m, { provider, threadId }, (path) =>
    readTranscriptFile(path, getProvider(provider), window),
  );
  return {
    dir: result.dir,
    read:
      result.source === 'readable'
        ? result.value
        : unavailableTranscript(
            provider,
            '',
            result.source === 'missing'
              ? 'transcript file not found'
              : 'transcript file unreadable',
          ),
  };
}

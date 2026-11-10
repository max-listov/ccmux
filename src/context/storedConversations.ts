import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Glob } from 'bun';
import { conversationTitle } from '../agent/claude/fork.ts';
import { knownProjectsDirs } from '../agent/claude/profileRoot.ts';
import {
  type CodexRolloutFile,
  currentRolloutFile,
  parseRolloutName,
  rolloutFile,
  sortRolloutFiles,
} from '../agent/codex/rolloutFiles.ts';
import { providerFor } from '../agent/index.ts';
import { ownedClaudeConversations } from '../external/claude.ts';
import { externalSessionKey } from '../external/keys.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { claudeLineage } from '../session/identity.ts';
import { loadSessions } from '../session/registry.ts';
import type { MachineConfig, Session } from '../types.ts';
import { nativeTranscriptPath } from './claude.ts';

/**
 * Every conversation this machine keeps on disk — not only the ones a session is running.
 *
 * A session list answers "what is alive"; a question about last month is about a conversation whose
 * session was removed, replaced by a fork or never managed at all. Those files stay where the
 * provider wrote them, so the store is what gets enumerated here, and the registry only decides how
 * each conversation is addressed.
 *
 * The address is the one `ccmux transcript` already accepts: a session's name for the file that
 * session reads now, the external storage key for everything else. `lines` says whether that command
 * can open the file at the line numbers a search reports — an earlier or compressed Codex file, and
 * a second Claude file under an id a session already reads, are searched but are not what the
 * address reads.
 *
 * A spawned agent's own transcript (the files beside a Claude session) is not a conversation here:
 * it is tool work, reachable through its parent's `--agent`.
 */
export interface StoredFile {
  path: string;
  /** zstd-compressed by the provider. */
  compressed: boolean;
  /** `ccmux transcript <address>` reads this file, so a line number found in it can be opened. */
  lines: boolean;
  /** When the provider started this file, where its name says so. */
  startMs: number | null;
}

export interface StoredConversation {
  provider: 'claude' | 'codex';
  threadId: string;
  address: string;
  /** The managed session reading this conversation now, or null. */
  session: string | null;
  /**
   * The managed session this conversation belongs or belonged to: the one reading it now, or the
   * one whose title the file opens with — a life that session left behind at a `/clear`, a fork or
   * a compaction. Null for a conversation no registered session ever lived in.
   */
  ofSession: string | null;
  /** The working directory, when the registry already knows it. Otherwise read from the file. */
  dir: string | null;
  /** Oldest first. */
  files: StoredFile[];
}

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

function entries(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function claudeConversations(m: MachineConfig, sessions: readonly Session[]): StoredConversation[] {
  const claude = sessions.filter((session) => session.agent === 'claude');
  /** The file each managed session reads, by path: the name is the address only for that file. */
  const reading = new Map<string, Session>();
  for (const session of claude) {
    // The same choice the window reader makes: the provider's file, or the native runtime's own.
    const path =
      providerFor(session).historyFile(session, m) ??
      (hasNativeRuntime(session) && session.nativeSession?.id !== undefined
        ? nativeTranscriptPath(session, m)
        : null);
    if (path !== null) reading.set(path, session);
  }
  // An id a managed session owns is refused as an external address, whichever file carries it.
  const owned = ownedClaudeConversations(claude);
  // The external reader takes the first store that holds an id, in this same order.
  const addressed = new Set<string>();
  const formerly = claudeLineage(m, claude);
  const out: StoredConversation[] = [];
  for (const root of knownProjectsDirs(claude, m)) {
    for (const project of entries(root)) {
      const projectDir = join(root, project);
      if (!isDirectory(projectDir)) continue;
      for (const name of entries(projectDir)) {
        const threadId = UUID_FILE.exec(name)?.[1];
        if (threadId === undefined) continue;
        const path = join(projectDir, name);
        const session = reading.get(path) ?? null;
        const external = session === null && !owned.has(threadId) && !addressed.has(threadId);
        if (external) addressed.add(threadId);
        out.push({
          provider: 'claude',
          threadId,
          address:
            session === null
              ? externalSessionKey('claude', m.rcPrefix, threadId)
              : `${m.rcPrefix}:${session.name}`,
          session: session?.name ?? null,
          // An id another session reads is that session's, whatever title this copy opens with.
          ofSession:
            session?.name ??
            (owned.has(threadId) ? null : (formerly(path, conversationTitle(path))?.name ?? null)),
          dir: session?.dir ?? null,
          files: [
            {
              path,
              compressed: false,
              lines: session !== null || external,
              startMs: null,
            },
          ],
        });
      }
    }
  }
  return out;
}

function rollouts(root: string): Map<string, CodexRolloutFile[]> {
  const threads = new Map<string, CodexRolloutFile[]>();
  if (!isDirectory(root)) return threads;
  for (const path of new Glob('**/rollout-*.jsonl*').scanSync({ cwd: root, absolute: true })) {
    const name = parseRolloutName(path.slice(path.lastIndexOf('/') + 1));
    if (name === null) continue;
    threads.set(name.thread, [...(threads.get(name.thread) ?? []), rolloutFile(path, name)]);
  }
  for (const files of threads.values()) sortRolloutFiles(files);
  return threads;
}

function codexConversations(m: MachineConfig, sessions: readonly Session[]): StoredConversation[] {
  if (!m.codexSessionsDir) return [];
  const live = rollouts(m.codexSessionsDir);
  const archived = rollouts(join(dirname(m.codexSessionsDir), 'archived_sessions'));
  const managed = new Map(
    sessions
      .filter((session) => session.agent === 'codex')
      .map((session) => [session.uuid, session]),
  );
  const out: StoredConversation[] = [];
  for (const threadId of new Set([...live.keys(), ...archived.keys()])) {
    const liveFiles = live.get(threadId) ?? [];
    const archivedFiles = archived.get(threadId) ?? [];
    // The reader looks in the live store first and in the archive only when the thread is not
    // there, and reads the newest uncompressed file of whichever it found.
    const current = currentRolloutFile(liveFiles.length > 0 ? liveFiles : archivedFiles);
    const session = liveFiles.length > 0 ? (managed.get(threadId) ?? null) : null;
    out.push({
      provider: 'codex',
      threadId,
      address:
        session === null
          ? externalSessionKey('codex', m.rcPrefix, threadId)
          : `${m.rcPrefix}:${session.name}`,
      session: session?.name ?? null,
      ofSession: session?.name ?? null,
      dir: session?.dir ?? null,
      files: sortRolloutFiles([...archivedFiles, ...liveFiles]).map((file) => ({
        path: file.path,
        compressed: file.compressed,
        lines: file === current,
        startMs: file.start,
      })),
    });
  }
  return out;
}

export function storedConversations(
  m: MachineConfig,
  sessions: readonly Session[] = loadSessions(m),
): StoredConversation[] {
  return [...claudeConversations(m, sessions), ...codexConversations(m, sessions)];
}

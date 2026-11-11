import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { conversationTitle, lastMessageMs } from '../agent/claude/fork.ts';
import { providerFor } from '../agent/index.ts';
import { rec, str } from '../agent/transcript/normalize.ts';
import { rcName } from '../config/machine.ts';
import { readInventory } from '../events/inventory.ts';
import { selfAddress } from '../fleet/address.ts';
import type { MachineConfig, Session } from '../types.ts';
import { entryNames } from '../util/entryNames.ts';
import { readFirstLine, readHeadLines } from '../util/readLines.ts';
import type { SessionIdentity, SessionLife } from './identitySchema.ts';
import { declaredProject, repositoryOf } from './repository.ts';

/**
 * A session's identity, assembled from what already records it: the registry (name, directory, the
 * id it reads now), the provider's own store (every earlier id, by the title each file opens with)
 * and the directory's `origin`.
 *
 * Nothing new is written to make this answerable. A session's earlier ids are not kept in a ledger
 * that would have to be right from the day it was introduced: the provider's files already say whose
 * they were, including for the lives that ended before anyone asked.
 */

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
/** How far into a file its first dated record is looked for: a conversation opens with undated
 *  bookkeeping records, and one of them — a file snapshot — runs to tens of kilobytes. */
const HEAD_BYTES = 256 * 1024;

interface FileTimes {
  firstAt: string | null;
  lastAt: string | null;
}

interface FileFacts {
  size: number;
  mtimeMs: number;
  /** Undefined until asked for: a title is a small read, the times a larger one, and most files in
   *  a shared directory are asked only for their title — they belong to another session. */
  title?: string | null;
  times?: FileTimes;
}

/**
 * What was read from each conversation file, kept while the file has not changed. A follower asks
 * for every identity again on each change of the registry; without this each of those would re-read
 * every conversation of every session to learn what it already knew.
 */
export type IdentityCache = Map<string, FileFacts>;

function iso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function timestampOf(line: string | null | undefined): number | null {
  if (!line) return null;
  try {
    const at = Date.parse(str(rec(JSON.parse(line))?.timestamp) ?? '');
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** The first record that says when it was written. A provider's opening record may run past the
 *  head that is read, so the whole first line is the fallback. */
function firstMessageMs(path: string): number | null {
  for (const line of readHeadLines(path, HEAD_BYTES)) {
    const at = timestampOf(line);
    if (at !== null) return at;
  }
  return timestampOf(readFirstLine(path));
}

/** The file's entry, emptied when the file has changed since it was read; null when it is gone. */
function factsOf(path: string, cache: IdentityCache): FileFacts | null {
  let stat: { size: number; mtimeMs: number };
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  const kept = cache.get(path);
  if (kept !== undefined && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs) return kept;
  const facts: FileFacts = { size: stat.size, mtimeMs: stat.mtimeMs };
  cache.set(path, facts);
  return facts;
}

function titleOf(path: string, facts: FileFacts): string | null {
  if (facts.title === undefined) facts.title = conversationTitle(path);
  return facts.title;
}

function timesOf(path: string, facts: FileFacts): FileTimes {
  facts.times ??= { firstAt: iso(firstMessageMs(path)), lastAt: iso(lastMessageMs(path)) };
  return facts.times;
}

function projectDirOf(session: Session, m: MachineConfig): string | null {
  if (session.agent !== 'claude') return null;
  const path = providerFor(session).historyFile(session, m);
  return path === null ? null : dirname(path);
}

/**
 * Which Claude session a conversation file belongs to, by the title it opens with.
 *
 * The file has to sit in the session's own project directory and carry the session's title. Two
 * sessions that would be shown under one title in one directory cannot be told apart by it, so
 * neither is given the other's files: such a title belongs to nobody.
 */
export function claudeLineage(
  m: MachineConfig,
  sessions: readonly Session[],
): (path: string, title: string | null) => Session | null {
  const owners = new Map<string, Session | null>();
  for (const session of sessions) {
    const project = projectDirOf(session, m);
    if (project === null) continue;
    const key = `${project}\n${rcName(m, session.name)}`;
    owners.set(key, owners.has(key) ? null : session);
  }
  return (path, title) =>
    title === null ? null : (owners.get(`${dirname(path)}\n${title}`) ?? null);
}

function claudeLives(
  m: MachineConfig,
  session: Session,
  sessions: readonly Session[],
  cache: IdentityCache,
): SessionLife[] {
  const project = projectDirOf(session, m);
  if (project === null) return [];
  const ownerOf = claudeLineage(m, sessions);
  // An id another session reads now is that session's, whatever title its file opens with.
  const taken = new Set(sessions.filter((other) => other !== session).map((other) => other.uuid));
  const lives: SessionLife[] = [];
  for (const name of entryNames(project)) {
    const id = UUID_FILE.exec(name)?.[1];
    if (id === undefined || taken.has(id)) continue;
    const path = join(project, name);
    const facts = factsOf(path, cache);
    if (facts === null) continue;
    const current = id === session.uuid;
    if (!current && ownerOf(path, titleOf(path, facts)) !== session) continue;
    lives.push({ id, current, ...timesOf(path, facts) });
  }
  return lives;
}

const ms = (at: string | null): number => (at === null ? 0 : Date.parse(at));

/** Every life of one session, oldest first; the one it reads now is always among them. */
function livesOf(
  m: MachineConfig,
  session: Session,
  sessions: readonly Session[],
  cache: IdentityCache,
): SessionLife[] {
  const lives = claudeLives(m, session, sessions, cache);
  if (!lives.some((life) => life.current)) {
    // A provider with one id for life, or a conversation whose file is not written yet.
    const path = providerFor(session).historyFile(session, m);
    const facts = path === null ? null : factsOf(path, cache);
    const times = path === null || facts === null ? null : timesOf(path, facts);
    lives.push({
      id: session.uuid,
      current: true,
      firstAt: times?.firstAt ?? null,
      lastAt: times?.lastAt ?? null,
    });
  }
  return lives.sort(
    (a, b) => ms(a.firstAt) - ms(b.firstAt) || Number(a.current) - Number(b.current),
  );
}

export async function sessionIdentities(
  m: MachineConfig,
  sessions: readonly Session[],
  cache: IdentityCache = new Map(),
): Promise<SessionIdentity[]> {
  const running = new Map(
    (readInventory(m)?.sessions ?? []).map((row) => [row.name, row.running] as const),
  );
  // Asked together: each is a `git` process, and one after another they are most of the answer's time.
  await Promise.all(sessions.map((session) => repositoryOf(session.dir)));
  const out: SessionIdentity[] = [];
  for (const session of sessions) {
    const conversations = livesOf(m, session, sessions, cache);
    const first = conversations.map((life) => ms(life.firstAt)).filter((at) => at > 0);
    const last = conversations.map((life) => ms(life.lastAt)).filter((at) => at > 0);
    out.push({
      address: selfAddress(m, session.name),
      machine: m.rcPrefix,
      name: session.name,
      provider: session.agent,
      title: rcName(m, session.name),
      dir: session.dir,
      repository: await repositoryOf(session.dir),
      ...(await declaredProject(session.dir)),
      archived: session.archived,
      running: running.get(session.name) ?? null,
      conversation: session.uuid,
      conversations,
      createdAt: first.length === 0 ? null : iso(Math.min(...first)),
      lastActivityAt: last.length === 0 ? null : iso(Math.max(...last)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The part of an identity a follower is told about. A session's activity times move with every
 * message it exchanges; sent as changes they would turn the stream into a transcript of who is
 * busy, which the event feed already is.
 */
export function stableIdentity(identity: SessionIdentity): string {
  const { lastActivityAt: _last, conversations, ...rest } = identity;
  return JSON.stringify({
    ...rest,
    conversations: conversations.map(({ lastAt: _at, ...life }) => life),
  });
}

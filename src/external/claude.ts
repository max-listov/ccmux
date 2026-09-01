import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { lastModel, parse, usedTokens } from '../agent/claude/transcript.ts';
import {
  classifyWriters,
  externalResumingUuids,
  parsePs,
  type Writer,
} from '../agent/claude/writers.ts';
import { rec, str } from '../agent/normalize.ts';
import { loadSessions } from '../config/sessions.ts';
import type { ExternalSession, MachineConfig, Session, WriterRuntime } from '../types.ts';
import { MtimeCache } from '../util/mtimeCache.ts';
import { readHeadLines, readTailUntil } from '../util/readLines.ts';
import { externalCapabilities } from './capabilities.ts';
import { externalSessionKey } from './keys.ts';
import { unknownTurnState } from './turnSchema.ts';

const HEAD_BYTES = 64 * 1024;
const TAIL_LINES = 2000;
const cache = new MtimeCache<Pick<
  ExternalSession,
  'dir' | 'lastActivityMs' | 'lastModel' | 'usedTokens' | 'lastMessage'
> | null>();

function processData(): { targets: Set<string>; output: string } | null {
  try {
    const result = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,ppid=,command='], { stderr: 'ignore' });
    if (!result.success) return null;
    const output = result.stdout.toString();
    return { targets: externalResumingUuids(parsePs(output)), output };
  } catch {
    return null;
  }
}

function firstCwd(lines: string[]): string | null {
  for (const raw of lines) {
    if (!raw) continue;
    try {
      const cwd = str(rec(JSON.parse(raw))?.cwd);
      if (cwd?.startsWith('/')) return cwd;
    } catch {
      // A bounded head slice can end with one partial JSON record.
    }
  }
  return null;
}

function writerRuntime(writers: Writer[]): WriterRuntime | null {
  if (writers.length === 0) return null;
  if (writers.length > 1) {
    return {
      kind: 'shared',
      pid: null,
      startTime: null,
      processGroup: null,
      reason: 'multiple Claude processes resume this thread',
    };
  }
  const writer = writers[0];
  if (!writer) return null;
  const kind: WriterRuntime['kind'] =
    writer.kind === 'desktop' ? 'desktop' : writer.kind === 'self' ? 'self' : 'dedicated-cli';
  return {
    kind,
    pid: writer.pid,
    startTime: null,
    processGroup: null,
    reason:
      writer.kind === 'desktop'
        ? 'Claude desktop process resumes this thread'
        : writer.kind === 'self'
          ? 'this ccmux process descends from the writer'
          : 'one dedicated Claude CLI process resumes this thread',
  };
}

function readSession(
  path: string,
): Pick<
  ExternalSession,
  'dir' | 'lastActivityMs' | 'lastModel' | 'usedTokens' | 'lastMessage'
> | null {
  return cache.get(path, () => {
    const tail = readTailUntil(
      path,
      TAIL_LINES,
      (lines) => lastModel(lines) !== null && usedTokens(lines) !== null,
    );
    if (tail.length === 0) return null;
    const messages = parse(tail.slice(-120), 1, 280);
    const lastMessage = messages.at(-1) ?? null;
    const parsedTime = lastMessage?.createdAt ? Date.parse(lastMessage.createdAt) : NaN;
    let lastActivityMs = Number.isFinite(parsedTime) ? parsedTime : null;
    if (lastActivityMs === null) {
      try {
        lastActivityMs = statSync(path).mtimeMs;
      } catch {
        lastActivityMs = null;
      }
    }
    return {
      dir: firstCwd(readHeadLines(path, HEAD_BYTES)) ?? firstCwd(tail),
      lastActivityMs,
      lastModel: lastModel(tail),
      usedTokens: usedTokens(tail),
      lastMessage,
    };
  });
}

/**
 * Every conversation id this machine already drives, so none is offered for adoption.
 *
 * A terminal session is pinned by its registry uuid. A native session also owns a conversation in
 * the same store under its native id, and adopting one this machine is already driving would put a
 * second writer on it — the one thing the supervisor exists to prevent. Exported so the rule is
 * tested by calling it rather than by a test re-implementing it beside the code.
 */
export function ownedClaudeConversations(sessions: readonly Session[]): Set<string> {
  return new Set(
    sessions
      .filter((session) => session.agent === 'claude')
      .flatMap((session) =>
        session.nativeSession === undefined
          ? [session.uuid]
          : [session.uuid, session.nativeSession.id],
      ),
  );
}

export function discoverClaude(m: MachineConfig): ExternalSession[] {
  if (!existsSync(m.projectsDir)) return [];
  const live = processData();
  if (!live) return [];
  /**
   * Conversations this machine already owns, by every id a managed session can hold.
   *
   * The registry uuid is the pin for a terminal session. A native session ALSO owns a conversation
   * in the same store under its native id, and the two are different values for every mode but this
   * one. Excluding only the uuid would offer a live native conversation for adoption, and adopting
   * it would put a second writer on a conversation this machine is already driving — the one thing
   * the whole supervisor is built to prevent.
   */
  const managed = ownedClaudeConversations(loadSessions(m));
  const targets = new Set([...live.targets].filter((threadId) => !managed.has(threadId)));
  if (targets.size === 0) return [];
  const processes = parsePs(live.output);
  const out: ExternalSession[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(m.projectsDir);
  } catch {
    return [];
  }
  for (const projectDir of projectDirs) {
    const root = `${m.projectsDir}/${projectDir}`;
    let files: string[];
    try {
      files = readdirSync(root);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const threadId = file.slice(0, -6);
      if (!targets.has(threadId)) continue;
      const path = `${root}/${file}`;
      const data = readSession(path);
      if (!data) continue;
      const writers = classifyWriters(processes, threadId, process.pid);
      const runtime = writerRuntime(writers);
      const evidence = writers.length > 0 ? 'observed' : 'unknown';
      out.push({
        key: externalSessionKey('claude', m.rcPrefix, threadId),
        plane: 'external',
        provider: 'claude',
        host: m.rcPrefix,
        threadId,
        dir: data.dir,
        path,
        origin: runtime?.kind === 'desktop' ? 'desktop' : 'cli',
        storage: 'stored',
        writerEvidence: evidence,
        writerRuntime: runtime,
        turnState: unknownTurnState('unsupported', 'unsupported-provider'),
        capabilities: externalCapabilities('stored', evidence, runtime),
        lastActivityMs: data.lastActivityMs,
        lastModel: data.lastModel,
        usedTokens: data.usedTokens,
        lastMessage: data.lastMessage,
      });
    }
  }
  return out.sort(
    (a, b) =>
      basename(a.dir ?? '').localeCompare(basename(b.dir ?? '')) ||
      a.threadId.localeCompare(b.threadId),
  );
}

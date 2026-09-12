import { claudeProvider } from '../agent/claude/index.ts';
import { subagentFile } from '../agent/claude/subagent.ts';
import { providerFor, readTranscript } from '../agent/index.ts';
import { clip, DEFAULT_TEXT_LIMIT } from '../agent/normalize.ts';
import {
  readTranscriptFile,
  type TranscriptRead,
  unavailableTranscript,
} from '../agent/transcriptRead.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type {
  AgentKind,
  MachineConfig,
  Session,
  TranscriptKind,
  TranscriptMessage,
  TranscriptRole,
  TranscriptStats,
} from '../types.ts';
import { nativeTranscriptPath } from './claude.ts';
import { HISTORY_LIMITS, type NativeHistoryEntry } from './schema.ts';
import { readNativeHistory } from './service.ts';

/** What a caller asks for, identical to the file reader's window. */
export interface TranscriptWindowOptions {
  tail: number;
  cursor?: number;
  before?: number;
  limit?: number;
  textLimit?: number;
  /** A spawned agent's transcript instead of the session's own, by the id its `Agent` call carries. */
  agent?: string;
}

/**
 * One session's transcript window, from whichever storage the session actually has.
 *
 * A runtime that keeps a jsonl file answers through the file reader, unchanged. A native runtime
 * that keeps none (openCode, custom) answers from its structured history feed — the same source the
 * `history` control read uses, because it is the only source that carries the operator's own
 * messages alongside the agent's. Addressing the runtime by a path it never writes is what made
 * `transcript.read` answer "file not found" for a conversation that was live one call away.
 *
 * The file check is the discriminator, not the runtime mode: codex app-server is native yet keeps a
 * real rollout file, and diverting it to the native feed would trade a working transcript for a
 * partial one.
 */
export async function readTranscriptWindow(
  m: MachineConfig,
  session: Session,
  window: TranscriptWindowOptions,
  signal?: AbortSignal,
): Promise<TranscriptRead> {
  if (providerFor(session).historyFile(session, m) !== null)
    return readTranscript(session, m, window);
  // Claude's native SDK writes its own jsonl, just not at the registry uuid the interactive provider
  // points at. Its own file is the source of truth and carries absolute lines, so it answers here.
  if (session.agent === 'claude' && hasNativeRuntime(session))
    return readClaudeNative(session, window);
  if (window.agent !== undefined)
    return unavailableTranscript(
      session.agent,
      '',
      'this runtime keeps no agent transcripts',
      'native',
    );
  return readNativeTranscript(m, session, window, signal);
}

function readClaudeNative(session: Session, window: TranscriptWindowOptions): TranscriptRead {
  const id = session.nativeSession?.id;
  if (id === undefined)
    return unavailableTranscript('claude', '', 'native transcript identity is absent', 'native');
  const path = nativeTranscriptPath(session);
  if (window.agent === undefined) return readTranscriptFile(path, claudeProvider, window);
  const agentPath = subagentFile(path, window.agent);
  return agentPath === null
    ? unavailableTranscript('claude', path, 'agent id is not one this runtime issues', 'native')
    : readTranscriptFile(agentPath, claudeProvider, window);
}

/** Pages fetched before the answer is declared partial. A conversation longer than this keeps its
 *  newest entries; without a native total there is no absolute index to page deeper by. */
const NATIVE_TRANSCRIPT_MAX_PAGES = 16;

/**
 * The newest bounded window of a native conversation.
 *
 * The runtime pages backward: the first page is the most recent messages (oldest first within the
 * page), and each cursor reaches one page older. Fetching the whole conversation lets every entry
 * carry an absolute `seq` on the same scale as a jsonl line number, so the caller's cursor,
 * `before` and `tail` all keep the meaning they have for a file-backed runtime.
 */
export async function readNativeTranscript(
  m: MachineConfig,
  session: Session,
  window: TranscriptWindowOptions,
  signal?: AbortSignal,
): Promise<TranscriptRead> {
  const budget = signal ?? AbortSignal.timeout(HISTORY_LIMITS.deadlineMs);
  const pages: NativeHistoryEntry[][] = [];
  let cursor: string | undefined;
  let complete = false;
  try {
    for (let page = 0; page < NATIVE_TRANSCRIPT_MAX_PAGES; page++) {
      const result = await readNativeHistory(
        m,
        session,
        { limit: HISTORY_LIMITS.entries, ...(cursor === undefined ? {} : { cursor }) },
        budget,
      );
      pages.push(result.entries);
      if (result.completeness === 'complete' || result.nextCursor === null) {
        complete = true;
        break;
      }
      cursor = result.nextCursor;
    }
  } catch {
    // No live owner, a cursor that no longer belongs to this context, a runtime that stopped
    // mid-read: all of these are "cannot read it now", which is an answer, not a fault to escalate
    // through the command. It must not look like an empty conversation — "unavailable" and "the
    // operator said nothing" call for different reactions.
    return unavailableTranscript(session.agent, '', 'native history unavailable', 'native');
  }
  // Pages arrive newest-first; each holds the older end of the previous page and is itself ordered
  // oldest-first, so reversing the page order and concatenating yields the whole conversation in
  // chronological order.
  const entries = pages.reverse().flat();
  return nativeTranscriptWindow(session.agent, entries, complete, window);
}

/** Pure window composition over a native conversation ordered oldest-first. Exported so the window
 *  arithmetic is testable without a live owner connection. */
export function nativeTranscriptWindow(
  agent: AgentKind,
  entries: NativeHistoryEntry[],
  complete: boolean,
  window: TranscriptWindowOptions,
): TranscriptRead {
  const total = entries.length;
  let start: number;
  let end: number | undefined;
  if (window.before !== undefined && Number.isFinite(window.before)) {
    const limit =
      window.limit !== undefined && Number.isFinite(window.limit) ? window.limit : window.tail;
    end = window.before - 1;
    start = window.before - limit;
  } else if (window.cursor !== undefined && Number.isFinite(window.cursor)) {
    start = window.cursor + 1;
  } else {
    start = total > window.tail ? total - window.tail + 1 : 1;
  }
  start = Math.max(1, start);
  const textLimit = window.textLimit ?? DEFAULT_TEXT_LIMIT;
  const messages: TranscriptMessage[] = [];
  for (let index = start - 1; index < (end ?? total); index++) {
    const entry = entries[index];
    if (entry === undefined) continue;
    // A native part that carries neither text nor a tool nor an image is not a transcript entry —
    // the same rule the jsonl parser applies to an item with nothing in it. `seq` stays the index
    // over every record, so it continues to mean "where in the conversation", not "where in this
    // window of messages".
    const message = nativeEntryMessage(entry, index + 1, textLimit);
    if (message !== null) messages.push(message);
  }
  return {
    agent,
    source: 'native',
    available: true,
    error: null,
    path: '',
    totalLines: total,
    messages,
    mtimeMs: null,
    firstLine: start,
    reachedStart: complete && start <= 1,
    stats: nativeStats(entries),
  };
}

function nativeStats(entries: NativeHistoryEntry[]): TranscriptStats {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let thinking = 0;
  for (const entry of entries) {
    if (entry.kind === 'tool') toolCalls++;
    else if (entry.kind === 'reasoning-summary') thinking++;
    else if (entry.kind === 'user') user++;
    else if (entry.kind === 'assistant') assistant++;
  }
  return { messages: user + assistant, user, assistant, toolCalls, thinking };
}

function nativeRole(kind: NativeHistoryEntry['kind']): TranscriptRole {
  switch (kind) {
    case 'user':
      return 'user';
    case 'assistant':
    case 'reasoning-summary':
      return 'assistant';
    case 'tool':
      return 'tool';
    case 'compaction':
      return 'system';
    default:
      return 'unknown';
  }
}

function nativeKind(kind: NativeHistoryEntry['kind']): TranscriptKind {
  switch (kind) {
    case 'user':
    case 'assistant':
      return 'message';
    case 'reasoning-summary':
      return 'thinking';
    case 'tool':
      return 'tool_call';
    case 'compaction':
      return 'event';
    default:
      return 'unknown';
  }
}

function nativeEntryMessage(
  entry: NativeHistoryEntry,
  seq: number,
  textLimit: number,
): TranscriptMessage | null {
  const tool = entry.tool;
  const text = entry.text === null ? null : clip(entry.text, textLimit);
  const hasText = text !== null && text !== '';
  const hasImage = entry.images.length > 0 || entry.omittedImages > 0;
  if (tool === null && !hasText && !hasImage) return null;
  const terminal = entry.status !== 'inProgress';
  return {
    id: entry.itemId,
    seq,
    // The native feed carries no per-entry timestamp, and inventing one would date a fact the
    // source never stated. A reader gets the ordering from `seq`.
    createdAt: null,
    role: nativeRole(entry.kind),
    kind: tool !== null ? 'tool_call' : hasText ? nativeKind(entry.kind) : 'image',
    text,
    title: tool !== null ? (tool.name ?? 'tool') : null,
    toolName: tool?.name ?? null,
    toolCallId: tool?.callId ?? null,
    status: entry.status === 'failed' ? 'error' : null,
    rawType: entry.kind,
    done: tool !== null && terminal,
    result: tool !== null && terminal ? tool.outcome : null,
    // A tool observation carries lifecycle and outcome, not the request body; claiming `input`
    // would mean reconstructing arguments the feed never carried.
    input: null,
    resultText: null,
    // The feed addresses images to its own attachment store, which this transcript path does not
    // resolve; the entry stays visible as an image without a fetchable address.
    image: null,
    usage: null,
    doneAt: null,
    agent: null,
  };
}

import { createReadStream, statSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { getProvider } from '../agent/index.ts';
import { rec, str } from '../agent/transcript/normalize.ts';
import type { TranscriptKind, TranscriptMessage, TranscriptRole } from '../types.ts';
import type { ConversationHits, CorpusMatch, MachineCoverage } from './corpusSearchSchema.ts';
import type { StoredConversation, StoredFile } from './storedConversations.ts';
import { matchMessage, type TranscriptMatch } from './transcriptSearch.ts';

/**
 * One pattern against every conversation a machine keeps.
 *
 * `transcript --grep` answers "where in THIS conversation"; the question that has no session in it
 * yet — where did we discuss this, how was it fixed last time — needs every conversation read, the
 * finished ones included. Each file is streamed once through the provider's own parser and the same
 * matcher the single-conversation search uses, so a match here is the match that search would show
 * at the same line.
 *
 * There is no index and nothing runs between searches. Measured on 5.8 GB of Claude and 5.9 GB of
 * Codex history (137 files): 10 s and 8 s for the whole of each, at under 250 MB resident. The
 * transcript line index is deliberately not used: it would be built for every file ever written to
 * answer a question that needs each of them read once.
 *
 * The parser is given no source path. With one it opens the transcript of every agent a Claude
 * session spawned, to describe the call that spawned it — nothing a search reads, and on the same
 * corpus that alone took the scan from 10 s to 46 s.
 */
export interface CorpusQuery {
  /** What to find. Absent, the search is an outline: what each side said, turn by turn. */
  pattern?: RegExp;
  roles?: ReadonlySet<TranscriptRole>;
  /** What counts as a match. A conversation is mostly tool output by volume, and a phrase found
   *  there is rarely the conversation the caller is looking for. */
  kinds: ReadonlySet<TranscriptKind>;
  providers?: ReadonlySet<'claude' | 'codex'>;
  /** Part of the conversation's working directory or of its session's name, compared without case. */
  project?: string;
  /** Inclusive bounds on when the matched message was written, in epoch milliseconds. */
  since?: number;
  until?: number;
  /** How many matches to keep. The newest are kept. */
  limit: number;
}

/** Source characters handed to the parser at once. Bounds memory; lines are not a unit of size. */
const BATCH_CHARS = 16 * 1024 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
/** Enough for any field a transcript carries; matching a clipped text would miss what was clipped. */
const SEARCH_TEXT_LIMIT = 1_000_000;
/** How far into a file its working directory is looked for. */
const DIR_LINES = 64;

/**
 * A file's complete lines in batches, each with the absolute number of its first line.
 *
 * Numbered the way the transcript index numbers them, so a line found here is the line `--before`
 * and `--cursor` mean. A last line without its newline is a record still being written and is not
 * yielded.
 */
export async function* fileLines(
  file: Pick<StoredFile, 'path' | 'compressed'>,
  batchChars = BATCH_CHARS,
): AsyncGenerator<{ lines: string[]; base: number }> {
  const raw = createReadStream(file.path, { highWaterMark: READ_CHUNK });
  const stream = file.compressed ? raw.pipe(createZstdDecompress()) : raw;
  // A failure of the file itself has to end the decompressed stream too, or the loop waits forever.
  if (stream !== raw) raw.on('error', (error) => stream.destroy(error));
  // Split on the newline BYTE and decode each line once. A line here runs to tens of megabytes and
  // arrives in small pieces; joining the unfinished line to every piece as text made one such line
  // cost the square of its length — 2 GB of rollouts took 150 s to split and 7 s to decompress.
  let pending: Buffer[] = [];
  let lines: string[] = [];
  let base = 1;
  let chars = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let from = 0;
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, from)) {
        const piece = chunk.subarray(from, at);
        const line =
          pending.length === 0
            ? piece.toString('utf8')
            : Buffer.concat([...pending, piece]).toString('utf8');
        pending = [];
        lines.push(line);
        chars += line.length;
        from = at + 1;
      }
      // Copied: the stream may reuse the memory behind a chunk it has handed over.
      if (from < chunk.length) pending.push(Buffer.from(chunk.subarray(from)));
      if (chars < batchChars) continue;
      yield { lines, base };
      base += lines.length;
      lines = [];
      chars = 0;
    }
    if (lines.length > 0) yield { lines, base };
  } finally {
    raw.destroy();
    stream.destroy();
  }
}

/** The working directory a conversation ran in, as its own first records state it. */
export async function storedDir(
  file: Pick<StoredFile, 'path' | 'compressed'>,
): Promise<string | null> {
  try {
    // One line at a time: a Codex rollout opens with its directory, and its lines run to megabytes.
    for await (const { lines, base } of fileLines(file, 1)) {
      for (const line of lines.slice(0, DIR_LINES)) {
        try {
          const entry = rec(JSON.parse(line));
          const cwd = str(entry?.cwd) ?? str(rec(entry?.payload)?.cwd);
          if (cwd?.startsWith('/')) return cwd;
        } catch {
          // Not a record; the next line may be.
        }
      }
      if (base + lines.length > DIR_LINES) break;
    }
  } catch {
    // Unreadable here is unreadable to the scan as well, and the scan is what reports it.
  }
  return null;
}

/** When a match was written, in epoch milliseconds; 0 when it does not say. */
export function matchTime(match: Pick<CorpusMatch, 'createdAt'>): number {
  const at = match.createdAt === null ? Number.NaN : Date.parse(match.createdAt);
  return Number.isFinite(at) ? at : 0;
}

/** By last match, oldest first — the order of `matches`, one line per conversation. */
export const olderConversation = (a: ConversationHits, b: ConversationHits): number =>
  matchTime({ createdAt: a.lastAt }) - matchTime({ createdAt: b.lastAt }) ||
  a.address.localeCompare(b.address);

/** Oldest first. The one order every list of matches is kept in, so "the newest N" is one cut. */
export const olderMatch = (a: CorpusMatch, b: CorpusMatch): number =>
  matchTime(a) - matchTime(b) || a.address.localeCompare(b.address) || a.seq - b.seq;

function fileSize(path: string): { size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export interface MachineSearch {
  coverage: MachineCoverage;
  /** Every conversation with a match, oldest last match first — not only those of `matches`. */
  conversations: ConversationHits[];
  matches: CorpusMatch[];
}

/**
 * Text the harness put into the user's side of a conversation.
 *
 * A reminder, a hook's output, the notice that a background task ended and the summary a compacted
 * conversation restarts from all arrive as user messages, and none of them is the user. Counted as
 * the user they bury the few lines a person actually wrote — on this corpus most "user" records are
 * these. They are the harness speaking, so a search treats them as `system`.
 */
const HARNESS_TEXT =
  /^\s*(?:<\/?(?:system-reminder|local-command-|command-(?:name|message|args)|task-notification|bash-(?:input|stdout|stderr)|user-prompt-submit-hook|pasted_content|environment_context|user_instructions|turn_aborted|external_codex_apps_|image[ >])|# AGENTS\.md instructions|Caveat: The messages below|This session is being continued from a previous conversation|\[Request interrupted by user|Your response above was stopped by)/;

export function isHarnessText(text: string | null): boolean {
  return text !== null && HARNESS_TEXT.test(text);
}

/** Characters of a message an outline shows: enough to tell what was asked or answered. */
const OUTLINE_CHARS = 320;

function outlineOf(message: TranscriptMessage): TranscriptMatch {
  const text = (message.text ?? '').replace(/\s+/g, ' ').trim();
  return {
    seq: message.seq,
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    kind: message.kind,
    toolName: message.toolName,
    field: 'text',
    count: 1,
    excerpt: {
      before: '',
      match: text.slice(0, OUTLINE_CHARS),
      after: text.length > OUTLINE_CHARS ? '…' : '',
    },
  };
}

/** One process reading the conversations it is given, one after another. */
export async function searchStored(
  machine: string,
  query: CorpusQuery,
  conversations: readonly StoredConversation[],
): Promise<MachineSearch> {
  const started = performance.now();
  const coverage: MachineCoverage = {
    machine,
    status: 'searched',
    elapsedMs: 0,
    conversations: 0,
    files: 0,
    bytes: 0,
    skippedFiles: 0,
    unreadableFiles: 0,
    total: 0,
  };
  let kept: CorpusMatch[] = [];
  const hits = new Map<string, ConversationHits>();
  const project = query.project?.toLowerCase();
  for (const conversation of conversations) {
    if (query.providers !== undefined && !query.providers.has(conversation.provider)) {
      coverage.skippedFiles += conversation.files.length;
      continue;
    }
    // Decided before the first file is opened for searching: a read ruled out by a date or a
    // directory is most of what a narrowed search saves.
    const candidates: { file: StoredFile; size: number }[] = [];
    for (const file of conversation.files) {
      const stat = fileSize(file.path);
      const tooOld = query.since !== undefined && stat !== null && stat.mtimeMs < query.since;
      // A Codex file's name carries when it was started, and nothing in it is older than that.
      const tooNew =
        query.until !== undefined && file.startMs !== null && file.startMs > query.until;
      if (stat === null || tooOld || tooNew) coverage.skippedFiles++;
      else candidates.push({ file, size: stat.size });
    }
    const newest = candidates.at(-1);
    if (newest === undefined) continue;
    const dir = conversation.dir ?? (await storedDir(newest.file));
    const named = `${dir ?? ''} ${conversation.session ?? ''}`.toLowerCase();
    if (project !== undefined && !named.includes(project)) {
      coverage.skippedFiles += candidates.length;
      continue;
    }
    coverage.conversations++;
    const parser = getProvider(conversation.provider);
    for (const { file, size } of candidates) {
      coverage.files++;
      coverage.bytes += size;
      try {
        // An outline keeps a turn's last answer, which is only known once the next request comes.
        let answer: TranscriptMessage | null = null;
        const keep = (match: TranscriptMatch): void => {
          if (query.roles !== undefined && !query.roles.has(match.role)) return;
          const at = match.createdAt === null ? Number.NaN : Date.parse(match.createdAt);
          // A message that does not say when it was written is in no date range.
          if (query.since !== undefined && !(at >= query.since)) return;
          if (query.until !== undefined && !(at <= query.until)) return;
          coverage.total++;
          const { id: _id, ...found } = match;
          const hit: CorpusMatch = {
            address: conversation.address,
            provider: conversation.provider,
            threadId: conversation.threadId,
            session: conversation.session,
            dir,
            lines: file.lines,
            ...found,
          };
          kept.push(hit);
          const seen = hits.get(conversation.address);
          if (seen === undefined) {
            hits.set(conversation.address, {
              address: conversation.address,
              provider: conversation.provider,
              threadId: conversation.threadId,
              session: conversation.session,
              dir,
              total: 1,
              user: match.role === 'user' ? 1 : 0,
              assistant: match.role === 'assistant' ? 1 : 0,
              firstAt: Number.isFinite(at) ? match.createdAt : null,
              lastAt: Number.isFinite(at) ? match.createdAt : null,
              sample: hit,
            });
            return;
          }
          seen.total++;
          if (match.role === 'user') seen.user++;
          if (match.role === 'assistant') seen.assistant++;
          if (!Number.isFinite(at)) return;
          if (seen.firstAt === null || at < Date.parse(seen.firstAt))
            seen.firstAt = match.createdAt;
          if (seen.lastAt === null || at >= Date.parse(seen.lastAt)) {
            seen.lastAt = match.createdAt;
            seen.sample = hit;
          }
        };
        for await (const { lines, base } of fileLines(file)) {
          for (const parsed of parser.parse(lines, base, SEARCH_TEXT_LIMIT, undefined, base)) {
            const message: TranscriptMessage =
              parsed.role === 'user' && isHarnessText(parsed.text)
                ? { ...parsed, role: 'system' }
                : parsed;
            if (query.pattern !== undefined) {
              const match = matchMessage(message, { ...query, pattern: query.pattern });
              if (match !== null) keep(match);
              continue;
            }
            if (message.kind !== 'message' || !message.text) continue;
            if (message.role === 'assistant') answer = message;
            if (message.role !== 'user') continue;
            if (answer !== null) keep(outlineOf(answer));
            answer = null;
            keep(outlineOf(message));
          }
          if (kept.length > query.limit * 4) kept = kept.sort(olderMatch).slice(-query.limit);
        }
        if (answer !== null) keep(outlineOf(answer));
      } catch {
        coverage.unreadableFiles++;
      }
    }
  }
  coverage.elapsedMs = Math.round(performance.now() - started);
  return {
    coverage,
    conversations: [...hits.values()].sort(olderConversation),
    matches: kept.sort(olderMatch).slice(-query.limit),
  };
}

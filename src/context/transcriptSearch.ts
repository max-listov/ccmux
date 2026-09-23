import { statSync } from 'node:fs';
import type { TranscriptRead } from '../agent/transcript/transcriptRead.ts';
import type { TranscriptKind, TranscriptMessage, TranscriptRole } from '../types.ts';
import type { TranscriptWindowOptions } from './transcriptWindow.ts';

/**
 * Finding a place in a conversation, answered by the command that already reads it.
 *
 * Without this an agent looking for "what happened to my task over there" dumped a window of JSON
 * whose size it guessed, guessed which field held the list, and ran its own regex over each record
 * serialized whole — so it matched ids, paths and its OWN earlier searches, and could not tell "not
 * found" from "not looked at". Each of those is answered here instead: the whole history is scanned
 * unless the caller narrows it, the answer states the range it covered, and a pattern is matched
 * against what the conversation said — never against the record's bookkeeping.
 */

/** Where in a message a match was found. `output` is a tool call's folded result. */
export type SearchField = 'text' | 'input' | 'output';

export interface TranscriptQuery {
  pattern: RegExp;
  roles?: ReadonlySet<TranscriptRole>;
  kinds?: ReadonlySet<TranscriptKind>;
  /** First absolute line to scan, inclusive. Defaults to the first line. */
  from?: number;
  /** Last absolute line to scan, inclusive. Defaults to the last line when the scan began. */
  to?: number;
  /** Only the newest this many lines — `--tail`, when the caller asks for it by name. */
  tail?: number;
  /** How many matches to return. The NEWEST are kept: a search is usually for what happened lately,
   *  and an older match stays reachable by narrowing with `to`. */
  limit: number;
}

export interface TranscriptMatch {
  seq: number;
  id: string;
  createdAt: string | null;
  role: TranscriptRole;
  kind: TranscriptKind;
  toolName: string | null;
  field: SearchField;
  /** Matches in this message across every searched field. */
  count: number;
  /** The first match with its surroundings, whitespace collapsed, split so a consumer can mark the
   *  match without searching for it a second time. */
  excerpt: { before: string; match: string; after: string };
}

export interface TranscriptSearch {
  /** The reader's own answer about the source: availability, error, path, whole-session totals. */
  read: Omit<TranscriptRead, 'messages'>;
  scanned: { firstLine: number; lastLine: number; messages: number };
  total: number;
  matches: TranscriptMatch[];
}

/**
 * How much of the file one read covers, in source bytes.
 *
 * Sized by bytes because lines are not a unit of size: a Claude transcript measured at 2 KB a line
 * and a Codex rollout at 26 KB, so one line count was either slow on the first or 1.6 GB of peak
 * memory on the second. Measured on those two files (94 MB and 774 MB, whole-history search):
 * 32 MB per read, with a collection between reads, answered in 0.4 s and 0.9 s at 217 MB and
 * 571 MB peak, where 4000 lines per read took 0.8 s and 1.35 s at 369 MB and 1644 MB.
 */
const BATCH_BYTES = 32 * 1024 * 1024;
/** Bounds on lines per read. Below the floor the per-read cost dominates (250 lines took twice as
 *  long as 1000 on the same file); above the ceiling the saving has already flattened. */
const BATCH_MIN_LINES = 250;
export const SEARCH_BATCH_LINES = 4000;
/** Characters of context either side of the match in an excerpt. */
const CONTEXT_CHARS = 60;
/** A match longer than this is shown by its start: the excerpt is for recognising the place. */
const MATCH_CHARS = 120;
/** Enough for any field a transcript carries; matching a clipped text would miss what was clipped. */
const SEARCH_TEXT_LIMIT = 1_000_000;

export class SearchPatternError extends Error {}

function batchLines(read: TranscriptRead): number {
  try {
    const perLine = statSync(read.path).size / Math.max(1, read.totalLines);
    return Math.min(
      SEARCH_BATCH_LINES,
      Math.max(BATCH_MIN_LINES, Math.floor(BATCH_BYTES / Math.max(1, perLine))),
    );
  } catch {
    return SEARCH_BATCH_LINES;
  }
}

/**
 * The caller's pattern as a regular expression.
 *
 * Case follows the pattern unless the caller says otherwise, the way `rg --smart-case` does: an
 * all-lowercase pattern is almost always typed without thinking about case, and one with a capital
 * in it almost always means that capital. Escapes are not letters the caller typed — `\S` is a class,
 * not an uppercase S — so they are ignored when deciding.
 */
export function compilePattern(
  source: string,
  options: { fixed?: boolean; caseMode?: 'smart' | 'ignore' | 'sensitive' } = {},
): RegExp {
  if (source === '') throw new SearchPatternError('empty pattern: it would match every message');
  const body = options.fixed === true ? source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : source;
  const mode = options.caseMode ?? 'smart';
  const literal = options.fixed === true ? source : source.replace(/\\./g, '');
  const ignore = mode === 'ignore' || (mode === 'smart' && literal === literal.toLowerCase());
  let pattern: RegExp;
  try {
    pattern = new RegExp(body, ignore ? 'gi' : 'g');
  } catch (error) {
    throw new SearchPatternError(
      `invalid pattern: ${error instanceof Error ? error.message : String(error)} (use -F for a literal string)`,
    );
  }
  // A pattern that matches empty text matches every message, and a result listing all of them reads
  // like a search that worked.
  if (pattern.test(''))
    throw new SearchPatternError('pattern matches empty text, so it would match every message');
  pattern.lastIndex = 0;
  return pattern;
}

/**
 * A tool call's arguments as the words they are.
 *
 * `input` is the arguments serialized as JSON, so a command's newline is the two characters `\n` and
 * its backslash is doubled. A pattern written against the command — `0\.3`, or an anchor at a line
 * start — would then miss it, and one written against the encoding would match quoting instead of
 * content. Each string value stands on its own line, which is how the command was written.
 */
export function inputText(input: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // Clipped to a display limit, or not JSON at all: the text is still the best there is.
    return input;
  }
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') values.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(parsed);
  return values.join('\n');
}

function fieldsOf(message: TranscriptMessage): [SearchField, string][] {
  const fields: [SearchField, string][] = [];
  if (message.text) fields.push(['text', message.text]);
  if (message.input) fields.push(['input', inputText(message.input)]);
  if (message.resultText) fields.push(['output', message.resultText]);
  return fields;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ');

function excerptAt(text: string, index: number, length: number): TranscriptMatch['excerpt'] {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const matched = text.slice(index, index + Math.min(length, MATCH_CHARS));
  const tail = index + matched.length;
  const end = Math.min(text.length, tail + CONTEXT_CHARS);
  return {
    before: (start > 0 ? '…' : '') + collapse(text.slice(start, index)).trimStart(),
    match: collapse(matched) + (length > MATCH_CHARS ? '…' : ''),
    after: collapse(text.slice(tail, end)).trimEnd() + (end < text.length ? '…' : ''),
  };
}

/** One message against the query, or null when it does not match. Exported for the tests. */
export function matchMessage(
  message: TranscriptMessage,
  query: Pick<TranscriptQuery, 'pattern' | 'roles' | 'kinds'>,
): TranscriptMatch | null {
  if (query.roles !== undefined && !query.roles.has(message.role)) return null;
  if (query.kinds !== undefined && !query.kinds.has(message.kind)) return null;
  const pattern = new RegExp(query.pattern.source, query.pattern.flags);
  let first: { field: SearchField; excerpt: TranscriptMatch['excerpt'] } | null = null;
  let count = 0;
  for (const [field, text] of fieldsOf(message)) {
    pattern.lastIndex = 0;
    for (let found = pattern.exec(text); found !== null; found = pattern.exec(text)) {
      count++;
      first ??= { field, excerpt: excerptAt(text, found.index, found[0].length) };
      // compilePattern refuses a pattern that matches empty text, but one can still match an empty
      // string somewhere specific (a lookahead); step past it rather than loop on it.
      if (found[0].length === 0) pattern.lastIndex++;
    }
  }
  if (first === null) return null;
  return {
    seq: message.seq,
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    kind: message.kind,
    toolName: message.toolName,
    field: first.field,
    count,
    excerpt: first.excerpt,
  };
}

/**
 * Scan a conversation through the same window reader every other transcript read uses.
 *
 * Reading through the window, rather than opening storage here, is what keeps one answer to "what is
 * in this conversation": a file-backed runtime, a native runtime and an external thread each already
 * have a reader, and a second way to read them would disagree with the first on the day one changes.
 *
 * A file is read in batches so memory stays bounded. A tool result that lands in a later batch than
 * its call is then reported as its own `tool_result` at its own line instead of folded into the call;
 * its text is still searched and its line is still true, which is what a search owes.
 *
 * A native runtime has no line index to seek by — its reader fetches the whole conversation for any
 * window — so it is read once rather than once per batch.
 */
export async function searchTranscript(
  readWindow: (window: TranscriptWindowOptions) => Promise<TranscriptRead>,
  query: TranscriptQuery,
  options: { agent?: string } = {},
): Promise<TranscriptSearch> {
  const agent = options.agent === undefined ? {} : { agent: options.agent };
  const probe = await readWindow({ tail: 1, textLimit: 1, ...agent });
  const { messages: _probed, ...read } = probe;
  const lastLine = Math.min(probe.totalLines, query.to ?? probe.totalLines);
  const firstLine = Math.max(
    1,
    query.from ?? 1,
    query.tail === undefined ? 1 : lastLine - query.tail + 1,
  );
  const result: TranscriptSearch = {
    read,
    scanned: { firstLine, lastLine: Math.max(firstLine - 1, lastLine), messages: 0 },
    total: 0,
    matches: [],
  };
  if (!probe.available || lastLine < firstLine) return result;
  const batch = probe.source === 'native' ? lastLine - firstLine + 1 : batchLines(probe);
  for (let start = firstLine; start <= lastLine; start += batch) {
    const end = Math.min(lastLine, start + batch - 1);
    const window = await readWindow({
      tail: batch,
      before: end + 1,
      limit: end - start + 1,
      textLimit: SEARCH_TEXT_LIMIT,
      ...agent,
    });
    if (!window.available) {
      // The source went away between batches. What was scanned stays reported as scanned; the rest
      // is not claimed.
      result.read = { ...result.read, available: false, error: window.error };
      result.scanned.lastLine = start - 1;
      break;
    }
    for (const message of window.messages) {
      if (message.seq < start || message.seq > end) continue;
      result.scanned.messages++;
      const match = matchMessage(message, query);
      if (match === null) continue;
      result.total++;
      result.matches.push(match);
      if (result.matches.length > query.limit) result.matches.shift();
    }
    // Each read is garbage the moment it is searched, and left to the collector's own pace it piled
    // up: peak memory grew with the number of reads, not the size of one. Collecting here cut the
    // peak on the 774 MB file by two thirds and made the search faster, because the heap never grew
    // large enough to be expensive to sweep.
    if (end < lastLine) Bun.gc(true);
  }
  return result;
}

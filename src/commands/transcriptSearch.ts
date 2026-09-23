import { TranscriptKindSchema, TranscriptRoleSchema } from '../agent/transcript/messageSchema.ts';
import type { TranscriptRead } from '../agent/transcript/transcriptRead.ts';
import {
  compilePattern,
  SearchPatternError,
  searchTranscript,
  type TranscriptMatch,
  type TranscriptQuery,
  type TranscriptSearch,
} from '../context/transcriptSearch.ts';
import type { TranscriptWindowOptions } from '../context/transcriptWindow.ts';
import type { TranscriptJson } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';

/** Matches shown when the caller does not say. The newest are kept and the count says how many more. */
export const DEFAULT_MATCHES = 50;

/** What the command line asks a search for, before it is turned into a query. */
export interface SearchArgs {
  grep: string;
  fixed: boolean;
  caseMode: 'smart' | 'ignore' | 'sensitive';
  roles: string[];
  kinds: string[];
  limit?: number;
  cursor?: number;
  before?: number;
  /** Only when the caller wrote `--tail`: its default is a window size, not a search range. */
  tail?: number;
  agent?: string;
}

function listed<T extends string>(
  what: string,
  values: string[],
  allowed: readonly T[],
): Set<T> | undefined {
  if (values.length === 0) return undefined;
  const unknown = values.filter((value) => !(allowed as readonly string[]).includes(value));
  if (unknown.length > 0)
    throw new SearchPatternError(
      `unknown ${what} ${unknown.map((value) => `'${value}'`).join(', ')}; one of: ${allowed.join(', ')}`,
    );
  return new Set(values as T[]);
}

/** The query, or the reason it cannot be one — decided before anything is read. */
export function searchQuery(args: SearchArgs): TranscriptQuery {
  const query: TranscriptQuery = {
    pattern: compilePattern(args.grep, { fixed: args.fixed, caseMode: args.caseMode }),
    limit: args.limit ?? DEFAULT_MATCHES,
  };
  const roles = listed('role', args.roles, TranscriptRoleSchema.options);
  const kinds = listed('kind', args.kinds, TranscriptKindSchema.options);
  if (roles !== undefined) query.roles = roles;
  if (kinds !== undefined) query.kinds = kinds;
  if (args.cursor !== undefined) query.from = args.cursor + 1;
  if (args.before !== undefined) query.to = args.before - 1;
  if (args.tail !== undefined) query.tail = args.tail;
  return query;
}

const HIGHLIGHT = ['\u001b[1;31m', '\u001b[0m'] as const;

function row(match: TranscriptMatch, now: number, color: boolean): string[] {
  const at = match.createdAt === null ? Number.NaN : Date.parse(match.createdAt);
  const { before, after } = match.excerpt;
  const hit = color ? `${HIGHLIGHT[0]}${match.excerpt.match}${HIGHLIGHT[1]}` : match.excerpt.match;
  return [
    String(match.seq),
    Number.isFinite(at) ? humanizeDuration(Math.max(0, now - at) / 1000) : '-',
    match.role,
    match.kind === 'tool_call' && match.toolName !== null ? `tool:${match.toolName}` : match.kind,
    match.field,
    `${before}${hit}${after}${match.count > 1 ? `  (+${match.count - 1})` : ''}`,
  ];
}

/** The range a search covered, said so that "nothing found" cannot be mistaken for "not looked". */
function coverage(search: TranscriptSearch): string {
  const { firstLine, lastLine, messages } = search.scanned;
  const total = search.read.totalLines;
  const range = lastLine < firstLine ? 'no lines' : `lines ${firstLine}–${lastLine}`;
  const whole = firstLine <= 1 && lastLine >= total ? 'whole history' : `of ${total}`;
  return `${messages} messages, ${range} (${whole})`;
}

export function searchSummary(search: TranscriptSearch, target: string): string[] {
  const lines: string[] = [];
  const found = search.total === 1 ? '1 match' : `${search.total} matches`;
  lines.push(`${search.total === 0 ? 'no matches' : found} in ${coverage(search)}`);
  const oldest = search.matches[0];
  if (search.total > search.matches.length && oldest !== undefined)
    lines.push(
      `showing the newest ${search.matches.length}; older ones: add --before ${oldest.seq}, or raise --limit`,
    );
  const newest = search.matches.at(-1);
  if (newest !== undefined)
    lines.push(
      `SEQ is a line: ccmux transcript ${target} --json --before ${newest.seq + 1} --limit 20 reads what led up to it`,
    );
  return lines;
}

/** The search as the command's JSON: the same session/source header a window read carries. */
export function searchJson(
  header: TranscriptJson,
  search: TranscriptSearch,
  query: TranscriptQuery,
): Record<string, unknown> {
  const { messages: _messages, cursor: _cursor, window: _window, ...rest } = header;
  return {
    ...rest,
    query: {
      pattern: query.pattern.source,
      flags: query.pattern.flags.replace('g', ''),
      roles: query.roles === undefined ? null : [...query.roles],
      kinds: query.kinds === undefined ? null : [...query.kinds],
      limit: query.limit,
    },
    scanned: {
      ...search.scanned,
      reachedStart: search.scanned.firstLine <= 1,
      reachedEnd: search.scanned.lastLine >= search.read.totalLines,
    },
    total: search.total,
    truncated: search.total > search.matches.length,
    matches: search.matches,
  };
}

/**
 * Run a search and print it. Returns the exit code the way grep does: 0 when something was found,
 * 1 when nothing was or the transcript could not be read — the printed line says which.
 */
export async function runSearch(
  readWindow: (window: TranscriptWindowOptions) => Promise<TranscriptRead>,
  args: SearchArgs,
  render: {
    json: boolean;
    target: string;
    header: (read: TranscriptRead) => TranscriptJson;
  },
): Promise<number> {
  let query: TranscriptQuery;
  try {
    query = searchQuery(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const search = await searchTranscript(
    readWindow,
    query,
    args.agent === undefined ? {} : { agent: args.agent },
  );
  if (render.json) {
    const header = render.header({ ...search.read, messages: [] });
    await printLine(JSON.stringify(searchJson(header, search, query)));
  } else if (!search.read.available) {
    console.error(`${render.target}: ${search.read.error ?? 'transcript unavailable'}`);
  } else {
    const now = Date.now();
    const color = process.stdout.isTTY === true;
    if (search.matches.length > 0)
      for (const line of tableLines(
        ['SEQ', 'AGE', 'ROLE', 'KIND', 'FIELD', 'MATCH'],
        search.matches.map((match) => row(match, now, color)),
      ))
        await printLine(line);
    for (const line of searchSummary(search, render.target)) await printLine(line);
  }
  return search.read.available && search.total > 0 ? 0 : 1;
}

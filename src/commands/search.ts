import { TranscriptKindSchema, TranscriptRoleSchema } from '../agent/transcript/messageSchema.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { matchTime } from '../context/corpusSearch.ts';
import type { CorpusSearchJson } from '../context/corpusSearchSchema.ts';
import {
  type SearchPlan,
  SearchRequestError,
  searchFleet,
  searchPlan,
  searchStanding,
} from '../context/searchFleet.ts';
import { SEARCH_PROVIDERS, SearchRequestSchema } from '../context/searchRequestSchema.ts';
import { listed, SearchPatternError } from '../context/transcriptSearch.ts';
import { humanizeDuration } from '../util/duration.ts';
import { HOME } from '../util/env.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';
import { COMMAND_SCHEMAS } from './answerSchemas.ts';
import { parseFlags, UsageError } from './flags.ts';
import { usageLine } from './help.ts';

/** `ccmux search` — reads the command line and prints what `context/searchFleet.ts` answers. */

export interface SearchOpts extends SearchPlan {
  json: boolean;
  /** One line per conversation instead of one per match. */
  map: boolean;
  /** One entry per distinct thing the pattern matched: where it arrived. */
  receipts: boolean;
}

const some = <T>(set: Set<T> | undefined): T[] | null => (set === undefined ? null : [...set]);

export function parseSearch(args: string[], now = Date.now()): SearchOpts {
  const flags = parseFlags('search', args, [0, 1]);
  const usage = (message: string) => new UsageError(`${message}\n${usageLine('search')}`);
  // The lines a person reads are one per match; a whole message does not fit one, and clipping
  // it there would make `--full` mean two things.
  if (flags.bool('full') && !flags.bool('json'))
    throw usage("--full is each message's whole text, in --json");
  if (flags.bool('receipts') && flags.bool('map'))
    throw usage('--receipts is where each thing a PATTERN matched arrived; it has no --map');
  if (flags.bool('local') && flags.list('machine').length > 0)
    throw usage('choose --local or --machine');
  const limit = flags.int('limit');
  const request = SearchRequestSchema.safeParse({
    pattern: flags.positionals[0] ?? null,
    fixed: flags.bool('fixed-strings'),
    caseMode: flags.bool('ignore-case')
      ? 'ignore'
      : flags.bool('case-sensitive')
        ? 'sensitive'
        : 'smart',
    roles: some(listed('role', flags.list('role'), TranscriptRoleSchema.options)),
    kinds: some(listed('kind', flags.list('kind'), TranscriptKindSchema.options)),
    providers: some(listed('provider', flags.list('provider'), SEARCH_PROVIDERS)),
    project: flags.str('project') || null,
    since: flags.str('since') ?? null,
    until: flags.str('until') ?? null,
    ...(limit === undefined ? {} : { limit }),
    full: flags.bool('full'),
    receipts: flags.bool('receipts'),
    machines: flags.bool('local')
      ? []
      : flags.list('machine').length > 0
        ? flags.list('machine')
        : null,
  });
  if (!request.success) {
    const issue = request.error.issues[0];
    // An empty pattern is the one shape a person types; say it as the pattern compiler does.
    if (issue?.path[0] === 'pattern')
      throw new SearchPatternError('empty pattern: it would match every message');
    throw usage(`--${String(issue?.path[0])}: ${issue?.message}`);
  }
  try {
    return {
      ...searchPlan(request.data, now),
      json: flags.bool('json'),
      map: flags.bool('map'),
      receipts: request.data.receipts,
    };
  } catch (error) {
    if (error instanceof SearchRequestError) throw usage(error.message);
    throw error;
  }
}

const HIGHLIGHT = ['\u001b[1;31m', '\u001b[0m'] as const;

const gigabytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.max(bytes > 0 ? 1 : 0, Math.round(bytes / 1024 ** 2))} MB`;

const homeRelative = (dir: string): string =>
  dir === HOME ? '~' : dir.startsWith(`${HOME}/`) ? `~${dir.slice(HOME.length)}` : dir;

/** The matches grouped by conversation, each under the address that opens it. */
export function searchLines(result: CorpusSearchJson, now: number, color: boolean): string[] {
  const lines: string[] = [];
  const groups = new Map<string, CorpusSearchJson['matches']>();
  for (const match of result.matches)
    groups.set(match.address, [...(groups.get(match.address) ?? []), match]);
  for (const [address, matches] of groups) {
    const first = matches[0] as CorpusSearchJson['matches'][number];
    lines.push(
      [address, first.provider, first.dir === null ? null : homeRelative(first.dir)]
        .filter((part) => part !== null)
        .join('  '),
    );
    const rows = matches.map((match) => {
      const at = matchTime(match);
      const { before, after } = match.excerpt;
      const hit = color
        ? `${HIGHLIGHT[0]}${match.excerpt.match}${HIGHLIGHT[1]}`
        : match.excerpt.match;
      return [
        match.lines ? String(match.seq) : '-',
        at > 0 ? humanizeDuration(Math.max(0, now - at) / 1000) : '-',
        match.role,
        match.kind === 'tool_call' && match.toolName !== null
          ? `tool:${match.toolName}`
          : match.kind,
        `${before}${hit}${after}${match.count > 1 ? `  (+${match.count - 1})` : ''}`,
      ];
    });
    for (const line of tableLines(['SEQ', 'AGE', 'ROLE', 'KIND', 'MATCH'], rows))
      lines.push(`  ${line}`);
  }
  return [...lines, ...summaryLines(result, groups.size)];
}

const day = (at: string | null): string => {
  if (at === null) return '-';
  const date = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
};

/**
 * Where a subject lived: one conversation per row, newest last, each with its newest line.
 *
 * A subject talked about for months matches thousands of lines, and the newest fifty of them are all
 * from this week. The question "where did we deal with this" is about conversations, so this view
 * counts every match and shows the conversations instead.
 */
export function mapLines(result: CorpusSearchJson, now: number, limit: number): string[] {
  const shown = result.conversations.slice(-limit);
  const lines: string[] = [];
  const rows = shown.map((row) => [
    row.address,
    row.dir === null ? '-' : homeRelative(row.dir),
    String(row.total),
    String(row.user),
    String(row.assistant),
    day(row.firstAt),
    row.lastAt === null ? '-' : humanizeDuration(Math.max(0, now - Date.parse(row.lastAt)) / 1000),
  ]);
  const table = tableLines(['ADDRESS', 'DIR', 'ALL', 'USER', 'AGENT', 'FIRST', 'LAST'], rows);
  if (shown.length > 0) lines.push(table[0] as string);
  shown.forEach((row, index) => {
    lines.push(table[index + 1] as string);
    const { before, match, after } = row.sample.excerpt;
    lines.push(`    ${row.sample.role}: ${before}${match}${after}`);
  });
  if (result.conversations.length > shown.length)
    lines.push(
      `showing the ${shown.length} conversations matched most recently of ${result.conversations.length}; raise --limit for the rest`,
    );
  lines.push(...summaryLines({ ...result, truncated: false, matches: [] }, shown.length));
  const last = shown.at(-1);
  if (last !== undefined)
    lines.push(
      `one conversation's lines: ccmux transcript '${last.address}' --grep PATTERN, or this search without --map and with --project`,
    );
  return lines;
}

/** One row per place a mark arrived: the mark, when, whose conversation, and what it belongs to. */
export function receiptLines(result: CorpusSearchJson, now: number): string[] {
  const receipts = result.receipts ?? { truncated: false, marks: [] };
  const rows = receipts.marks.flatMap(({ mark, deliveries }) =>
    deliveries.map((row, index) => [
      index === 0 ? mark : '',
      row.receivedAt === null
        ? '-'
        : humanizeDuration(Math.max(0, now - Date.parse(row.receivedAt)) / 1000),
      row.ofSession === null ? row.address : `${row.machine}:${row.ofSession}`,
      // Absent from a machine whose release does not say; `-` is not "a person".
      row.sender?.verdict ?? '-',
      row.repository ?? '-',
      row.project ?? '-',
    ]),
  );
  const lines =
    rows.length === 0 ? [] : tableLines(['MARK', 'AGO', 'IN', 'BY', 'REPOSITORY', 'PROJECT'], rows);
  if (receipts.truncated)
    lines.push(
      `more than ${receipts.marks.length} distinct marks matched; narrow the pattern, --since or --until`,
    );
  lines.push(
    `${receipts.marks.length} mark(s), ${rows.length} place(s)`,
    ...summaryLines({ ...result, truncated: false, matches: [] }, 0),
  );
  return lines;
}

function summaryLines(result: CorpusSearchJson, shownConversations: number): string[] {
  const lines: string[] = [];
  const searched = result.machines.filter((row) => row.status === 'searched');
  const missing = result.machines.filter((row) => row.status === 'unavailable');
  // An outline has no pattern, so what it lists was not matched against anything.
  const [one, many] =
    result.query.pattern === null ? ['message', 'messages'] : ['match', 'matches'];
  const found =
    (result.total === 0
      ? `no ${many}`
      : result.total === 1
        ? `1 ${one}`
        : `${result.total} ${many}`) +
    (result.total === 0 ? '' : ` in ${result.conversations.length} conversation(s)`);
  const where = searched
    .map(
      (row) =>
        `${row.machine} (${row.conversations} conversations, ${gigabytes(row.bytes)}, ${(row.elapsedMs / 1000).toFixed(1)}s)`,
    )
    .join(', ');
  lines.push(`${found} — searched ${where === '' ? 'no machine' : where}`);
  // Said as loudly as the result: a machine that was not searched is where the answer may be.
  for (const row of missing) lines.push(`NOT SEARCHED: ${row.machine} — ${row.error}`);
  const unreadable = searched.filter((row) => row.unreadableFiles > 0);
  if (unreadable.length > 0)
    lines.push(
      `not read to the end: ${unreadable.map((row) => `${row.unreadableFiles} file(s) on ${row.machine}`).join(', ')}`,
    );
  if (result.truncated)
    lines.push(
      `showing the newest ${result.matches.length} in ${shownConversations} conversation(s); narrow with --until, --since, --project or --role, or raise --limit`,
    );
  const openable = result.matches.findLast((match) => match.lines);
  if (openable !== undefined)
    lines.push(
      `SEQ is a line: ccmux transcript '${openable.address}' --json --before ${openable.seq + 1} --limit 20 reads what led up to it`,
    );
  if (result.matches.some((match) => !match.lines))
    lines.push(
      "SEQ '-': the match is in a file ccmux transcript does not read by line (an earlier or compressed Codex file, or a second file under an id a session already reads); the excerpt is what there is",
    );
  return lines;
}

export async function cmdSearch(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--schema') {
    await printLine(JSON.stringify(COMMAND_SCHEMAS.search()));
    return 0;
  }
  let opts: SearchOpts;
  try {
    opts = parseSearch(args);
  } catch (error) {
    if (!(error instanceof SearchPatternError)) throw error;
    console.error(error.message);
    return 2;
  }
  const result = await searchFleet(loadMachineConfig(), opts);
  const lines = opts.json
    ? [JSON.stringify(result)]
    : opts.receipts
      ? receiptLines(result, Date.now())
      : opts.map
        ? mapLines(result, Date.now(), opts.query.limit)
        : searchLines(result, Date.now(), process.stdout.isTTY === true);
  for (const line of lines) await printLine(line);
  return searchStanding(result);
}

import { TranscriptKindSchema, TranscriptRoleSchema } from '../agent/transcript/messageSchema.ts';
import { loadMachineConfig } from '../config/machine.ts';
import {
  type CorpusQuery,
  matchTime,
  olderConversation,
  olderMatch,
} from '../context/corpusSearch.ts';
import { type CorpusSearchJson, CorpusSearchJsonSchema } from '../context/corpusSearchSchema.ts';
import { searchMachine } from '../context/corpusShards.ts';
import { storedConversations } from '../context/storedConversations.ts';
import { compilePattern, SearchPatternError } from '../context/transcriptSearch.ts';
import { peersOf, remoteFailureCause, runPeer as runFleetPeer } from '../fleet/transport.ts';
import type { MachineConfig, Session, TranscriptRole } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { HOME } from '../util/env.ts';
import { printLine } from '../util/stdout.ts';
import { tableLines } from '../util/table.ts';
import { parseFlags, UsageError } from './flags.ts';
import { usageLine } from './help.ts';
import { DEFAULT_MATCHES, listed } from './transcriptSearch.ts';

/**
 * `ccmux search` — one pattern against every stored conversation on every machine of the fleet.
 *
 * Each machine searches its own store: this command runs the search here and asks every other
 * machine to run the same one with `--local`, so the conversations never travel, only the matches.
 * A machine that did not answer is named in the result. Its silence is not "no matches there", and
 * a search that found nothing while a machine was unreachable exits 2, not 1.
 */

/** A search reads gigabytes on the far side; the default hop deadline is for a command that answers
 *  at once. */
const PEER_TIMEOUT_MS = 180_000;
const PEER_CONNECT_SECONDS = 5;

const PROVIDERS = ['claude', 'codex'] as const;
const DAY_MS = 86_400_000;
const UNIT_MS: Record<string, number> = { h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };

/**
 * A point in time as the caller wrote it: `today`, `yesterday`, `7d`/`12h`/`2w` ago, a day, or a
 * full timestamp.
 *
 * A bare day is that whole day in this machine's zone — from its first moment as `--since`, to its
 * last as `--until` — because "until the 3rd" said by a person includes the 3rd.
 */
export function parseWhen(text: string, edge: 'since' | 'until', now = Date.now()): number {
  if (text === 'today' || text === 'yesterday') {
    const day = new Date(now);
    const start = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate() - (text === 'today' ? 0 : 1),
    ).getTime();
    return edge === 'since' ? start : start + DAY_MS - 1;
  }
  const relative = /^(\d+)([hdw])$/.exec(text);
  if (relative) return now - Number(relative[1]) * (UNIT_MS[relative[2] as string] as number);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const start = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
    return edge === 'since' ? start : start + DAY_MS - 1;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at))
    throw new SearchPatternError(
      `--${edge} '${text}' is not a time: use today, yesterday, 7d, 12h, 2w, YYYY-MM-DD or a full timestamp`,
    );
  return at;
}

export interface SearchOpts {
  query: CorpusQuery;
  json: boolean;
  /** One line per conversation instead of one per match. */
  map: boolean;
  /** Machines to ask, or null for every machine of the fleet. */
  machines: string[] | null;
  /** What a peer is asked with, so it runs this exact search on its own store. */
  peerArgs: string[];
}

export function parseSearch(args: string[], now = Date.now()): SearchOpts {
  const flags = parseFlags('search', args, [0, 1]);
  const caseMode = flags.bool('ignore-case')
    ? 'ignore'
    : flags.bool('case-sensitive')
      ? 'sensitive'
      : 'smart';
  const source = flags.positionals[0];
  const kinds = listed('kind', flags.list('kind'), TranscriptKindSchema.options);
  const query: CorpusQuery = {
    kinds: kinds ?? new Set(['message']),
    limit: flags.int('limit') ?? DEFAULT_MATCHES,
  };
  if (source !== undefined)
    query.pattern = compilePattern(source, { fixed: flags.bool('fixed-strings'), caseMode });
  const roles = listed('role', flags.list('role'), TranscriptRoleSchema.options);
  const providers = listed('provider', flags.list('provider'), PROVIDERS);
  const project = flags.str('project');
  const since = flags.str('since');
  const until = flags.str('until');
  // What the two sides said. A `system` record is the harness talking — a hook's output, a reminder
  // — and it names things nobody in the conversation mentioned. A caller who names kinds has said
  // what they want, and a tool result's role is `tool`: no role is then assumed for them.
  const assumed = kinds === undefined ? new Set<TranscriptRole>(['user', 'assistant']) : undefined;
  const wanted = roles ?? assumed;
  if (wanted !== undefined) query.roles = wanted;
  if (providers !== undefined) query.providers = providers;
  if (project !== undefined && project !== '') query.project = project;
  if (since !== undefined) query.since = parseWhen(since, 'since', now);
  if (until !== undefined) query.until = parseWhen(until, 'until', now);
  // Without a pattern the search is an outline, and an outline of everything ever said is not one.
  if (query.pattern === undefined && query.project === undefined && query.since === undefined)
    throw new UsageError(
      `without a PATTERN, say which conversations to outline: --project or --since\n${usageLine('search')}`,
    );
  if (query.pattern === undefined && kinds !== undefined)
    throw new UsageError(
      `--kind needs a PATTERN: an outline is of messages\n${usageLine('search')}`,
    );
  if (flags.bool('local') && flags.list('machine').length > 0)
    throw new UsageError(`choose --local or --machine\n${usageLine('search')}`);
  // The compiled pattern and absolute times, not the words: a peer in another zone, or asked a
  // moment later, must search the same range with the same case rule.
  const peerArgs = [
    ...(kinds === undefined ? [] : ['--kind', [...kinds].join(',')]),
    '--limit',
    String(query.limit),
    ...(query.roles === undefined ? [] : ['--role', [...query.roles].join(',')]),
    ...(providers === undefined ? [] : ['--provider', [...providers].join(',')]),
    ...(query.project === undefined ? [] : ['--project', query.project]),
    ...(query.since === undefined ? [] : ['--since', new Date(query.since).toISOString()]),
    ...(query.until === undefined ? [] : ['--until', new Date(query.until).toISOString()]),
    // Last and after `--`, so a pattern is never read as a flag.
    ...(query.pattern === undefined
      ? []
      : [
          query.pattern.flags.includes('i') ? '--ignore-case' : '--case-sensitive',
          '--',
          query.pattern.source,
        ]),
  ];
  return {
    query,
    json: flags.bool('json'),
    map: flags.bool('map'),
    machines: flags.bool('local')
      ? []
      : flags.list('machine').length > 0
        ? flags.list('machine')
        : null,
    peerArgs,
  };
}

/** How another machine is asked. A parameter so the fleet half is tested without a fleet. */
export type PeerRunner = typeof runFleetPeer;

type MachineAnswer = Pick<CorpusSearchJson, 'machines' | 'matches' | 'conversations'>;

const unavailable = (machine: string, error: string): MachineAnswer => ({
  machines: [{ machine, status: 'unavailable', error }],
  matches: [],
  conversations: [],
});

async function askPeer(
  m: MachineConfig,
  peer: { machine: string; alias: string | null },
  peerArgs: string[],
  runPeer: PeerRunner,
): Promise<MachineAnswer> {
  const argv = ['ccmux', 'search', '--local', '--json', ...peerArgs];
  const result = await runPeer(m, peer.machine, peer.alias, argv, {
    timeoutMs: PEER_TIMEOUT_MS,
    connectTimeoutSeconds: PEER_CONNECT_SECONDS,
  });
  if (result.transportFailed)
    return unavailable(peer.machine, result.failureDetail ?? 'not reachable right now');
  let answer: CorpusSearchJson;
  try {
    answer = CorpusSearchJsonSchema.parse(JSON.parse(result.stdout));
  } catch {
    const cause = remoteFailureCause(result.stderr) ?? remoteFailureCause(result.stdout);
    return unavailable(
      peer.machine,
      `no search answer (exit ${result.code}): ${cause ?? 'nothing reported'} — is ccmux there older than this command?`,
    );
  }
  const own = answer.machines.filter((row) => row.machine === peer.machine);
  if (own.length !== answer.machines.length || own.length !== 1)
    return unavailable(peer.machine, 'the answer came from a different machine than the one asked');
  return { machines: own, matches: answer.matches, conversations: answer.conversations };
}

async function searchHere(
  m: MachineConfig,
  query: CorpusQuery,
  sessions?: readonly Session[],
): Promise<MachineAnswer> {
  const { coverage, matches, conversations } = await searchMachine(
    m.rcPrefix,
    query,
    storedConversations(m, sessions),
  );
  return {
    machines: [coverage],
    matches: matches.map((match) => ({ ...match, machine: m.rcPrefix })),
    conversations: conversations.map((row) => ({ ...row, machine: m.rcPrefix })),
  };
}

export async function searchFleet(
  m: MachineConfig,
  opts: SearchOpts,
  runPeer: PeerRunner = runFleetPeer,
  sessions?: readonly Session[],
): Promise<CorpusSearchJson> {
  const peers = peersOf(m);
  const wanted = opts.machines ?? [m.rcPrefix, ...peers.map((peer) => peer.machine)];
  const targets = opts.machines?.length === 0 ? [m.rcPrefix] : wanted;
  const answers = await Promise.all(
    [...new Set(targets)].map((machine): Promise<MachineAnswer> => {
      if (machine === m.rcPrefix) return searchHere(m, opts.query, sessions);
      const peer = peers.find((candidate) => candidate.machine === machine);
      return peer === undefined
        ? Promise.resolve(unavailable(machine, 'not a machine of this fleet (see ccmux fleet)'))
        : askPeer(m, peer, opts.peerArgs, runPeer);
    }),
  );
  const machines = answers.flatMap((answer) => answer.machines);
  const total = machines.reduce((sum, row) => sum + (row.status === 'searched' ? row.total : 0), 0);
  const matches = answers
    .flatMap((answer) => answer.matches)
    .sort(olderMatch)
    .slice(-opts.query.limit);
  const { query } = opts;
  return {
    query: {
      pattern: query.pattern?.source ?? null,
      flags: (query.pattern?.flags ?? '').replace('g', ''),
      roles: query.roles === undefined ? null : [...query.roles],
      kinds: [...query.kinds],
      providers: query.providers === undefined ? null : [...query.providers],
      project: query.project ?? null,
      since: query.since === undefined ? null : new Date(query.since).toISOString(),
      until: query.until === undefined ? null : new Date(query.until).toISOString(),
      limit: query.limit,
    },
    machines,
    total,
    truncated: total > matches.length,
    conversations: answers.flatMap((answer) => answer.conversations).sort(olderConversation),
    matches,
  };
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
    : opts.map
      ? mapLines(result, Date.now(), opts.query.limit)
      : searchLines(result, Date.now(), process.stdout.isTTY === true);
  for (const line of lines) await printLine(line);
  if (result.total > 0) return 0;
  return result.machines.some((row) => row.status === 'unavailable') ? 2 : 1;
}

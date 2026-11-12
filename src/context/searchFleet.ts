import { askPeer, FROM_ANOTHER_MACHINE, NOT_IN_FLEET, type PeerRunner } from '../fleet/askPeer.ts';
import { peersOf } from '../fleet/transport.ts';
import type { MachineConfig, Session, TranscriptRole } from '../types.ts';
import {
  type CorpusQuery,
  mergeReceipts,
  olderConversation,
  olderMatch,
  SEARCH_TEXT_LIMIT,
} from './corpusSearch.ts';
import { type CorpusSearchJson, CorpusSearchJsonSchema } from './corpusSearchSchema.ts';
import { searchMachine } from './corpusShards.ts';
import { conversationSenders } from './messageSender.ts';
import type { SearchRequest } from './searchRequestSchema.ts';
import { storedConversations } from './storedConversations.ts';
import { compilePattern, SearchPatternError } from './transcriptSearch.ts';

/**
 * One pattern against every stored conversation on every machine of the fleet.
 *
 * Each machine searches its own store: the search runs here and every other machine is asked to run
 * the same one with `--local`, so the conversations never travel, only the matches. A machine that
 * did not answer is named in the result. Its silence is not "no matches there".
 */

/** A search reads gigabytes on the far side; the default hop deadline is for a command that answers
 *  at once. */
const PEER_TIMEOUT_MS = 180_000;
const PEER_CONNECT_SECONDS = 5;

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

/** A request that names no search: said to the caller as it is, before anything is read. */
export class SearchRequestError extends Error {}

/** A search ready to run: here, and as every other machine is asked to run it. */
export interface SearchPlan {
  query: CorpusQuery;
  /** Machines to ask, or null for every machine of the fleet. */
  machines: string[] | null;
  /** What a peer is asked with, so it runs this exact search on its own store. */
  peerArgs: string[];
}

export function searchPlan(request: SearchRequest, now = Date.now()): SearchPlan {
  const kinds = request.kinds === null ? undefined : new Set(request.kinds);
  const query: CorpusQuery = { kinds: kinds ?? new Set(['message']), limit: request.limit };
  if (request.pattern !== null)
    query.pattern = compilePattern(request.pattern, {
      fixed: request.fixed,
      caseMode: request.caseMode,
    });
  // What the two sides said. A `system` record is the harness talking — a hook's output, a reminder
  // — and it names things nobody in the conversation mentioned. A caller who names kinds has said
  // what they want, and a tool result's role is `tool`: no role is then assumed for them.
  const assumed = kinds === undefined ? new Set<TranscriptRole>(['user', 'assistant']) : undefined;
  const wanted = request.roles === null ? assumed : new Set(request.roles);
  if (wanted !== undefined) query.roles = wanted;
  if (request.providers !== null) query.providers = new Set(request.providers);
  if (request.project !== null) query.project = request.project;
  if (request.since !== null) query.since = parseWhen(request.since, 'since', now);
  if (request.until !== null) query.until = parseWhen(request.until, 'until', now);
  // Without a pattern the search is an outline, and an outline of everything ever said is not one.
  if (query.pattern === undefined && query.project === undefined && query.since === undefined)
    throw new SearchRequestError(
      'without a PATTERN, say which conversations to outline: --project or --since',
    );
  if (query.pattern === undefined && kinds !== undefined)
    throw new SearchRequestError('--kind needs a PATTERN: an outline is of messages');
  if (request.full) query.full = true;
  if (request.receipts) {
    if (query.pattern === undefined)
      throw new SearchRequestError(
        '--receipts is where each thing a PATTERN matched arrived; it has no --map',
      );
    query.receipts = true;
  }
  // The compiled pattern and absolute times, not the words: a peer in another zone, or asked a
  // moment later, must search the same range with the same case rule.
  const peerArgs = [
    ...(kinds === undefined ? [] : ['--kind', [...kinds].join(',')]),
    '--limit',
    String(query.limit),
    ...(query.roles === undefined ? [] : ['--role', [...query.roles].join(',')]),
    ...(query.providers === undefined ? [] : ['--provider', [...query.providers].join(',')]),
    ...(query.project === undefined ? [] : ['--project', query.project]),
    ...(query.since === undefined ? [] : ['--since', new Date(query.since).toISOString()]),
    ...(query.until === undefined ? [] : ['--until', new Date(query.until).toISOString()]),
    ...(query.full === true ? ['--full'] : []),
    ...(query.receipts === true ? ['--receipts'] : []),
    // Last and after `--`, so a pattern is never read as a flag.
    ...(query.pattern === undefined
      ? []
      : [
          query.pattern.flags.includes('i') ? '--ignore-case' : '--case-sensitive',
          '--',
          query.pattern.source,
        ]),
  ];
  return { query, machines: request.machines, peerArgs };
}

type MachineAnswer = Pick<CorpusSearchJson, 'machines' | 'matches' | 'conversations' | 'receipts'>;

const unavailable = (machine: string, error: string): MachineAnswer => ({
  machines: [{ machine, status: 'unavailable', error }],
  matches: [],
  conversations: [],
});

async function askMachine(
  m: MachineConfig,
  peer: { machine: string; alias: string | null },
  peerArgs: string[],
  runPeer: PeerRunner | undefined,
): Promise<MachineAnswer> {
  const asked = await askPeer(
    m,
    peer,
    // Said to the machine asked, so it does not record as its own a search that is ours to record.
    ['ccmux', 'search', '--local', '--json', '--asked-by', m.rcPrefix, ...peerArgs],
    (stdout) => CorpusSearchJsonSchema.parse(JSON.parse(stdout)),
    {
      what: 'search',
      timeoutMs: PEER_TIMEOUT_MS,
      connectTimeoutSeconds: PEER_CONNECT_SECONDS,
      runPeer,
    },
  );
  if (!asked.ok) return unavailable(peer.machine, asked.error);
  const { answer } = asked;
  const own = answer.machines.filter((row) => row.machine === peer.machine);
  if (own.length !== answer.machines.length || own.length !== 1)
    return unavailable(peer.machine, FROM_ANOTHER_MACHINE);
  return {
    machines: own,
    matches: answer.matches,
    conversations: answer.conversations,
    ...(answer.receipts === undefined ? {} : { receipts: answer.receipts }),
  };
}

async function searchHere(
  m: MachineConfig,
  query: CorpusQuery,
  sessions?: readonly Session[],
): Promise<MachineAnswer> {
  const { coverage, matches, conversations, receipts } = await searchMachine(
    m.rcPrefix,
    query,
    storedConversations(m, sessions),
    undefined,
    query.receipts === true ? conversationSenders(m, SEARCH_TEXT_LIMIT) : undefined,
  );
  return {
    machines: [coverage],
    matches: matches.map((match) => ({ ...match, machine: m.rcPrefix })),
    conversations: conversations.map((row) => ({ ...row, machine: m.rcPrefix })),
    ...(receipts === undefined
      ? {}
      : {
          receipts: {
            truncated: receipts.truncated,
            marks: receipts.marks.map(({ mark, deliveries }) => ({
              mark,
              deliveries: deliveries.map((row) => ({ ...row, machine: m.rcPrefix })),
            })),
          },
        }),
  };
}

export async function searchFleet(
  m: MachineConfig,
  opts: SearchPlan,
  runPeer?: PeerRunner,
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
        ? Promise.resolve(unavailable(machine, NOT_IN_FLEET))
        : askMachine(m, peer, opts.peerArgs, runPeer);
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
      full: query.full === true,
      ...(query.receipts === true ? { receipts: true } : {}),
    },
    machines,
    total,
    truncated: total > matches.length,
    conversations: answers.flatMap((answer) => answer.conversations).sort(olderConversation),
    matches,
    ...(query.receipts === true
      ? { receipts: mergeReceipts(answers.map((answer) => answer.receipts)) }
      : {}),
  };
}

/** Found, not found, or not found with a machine that was not searched — the command's exit code. */
export function searchStanding(result: CorpusSearchJson): 0 | 1 | 2 {
  if (result.total > 0) return 0;
  return result.machines.some((row) => row.status === 'unavailable') ? 2 : 1;
}

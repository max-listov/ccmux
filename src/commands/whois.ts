import { mkdirSync, watch } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { loadMachineConfig } from '../config/machine.ts';
import { inventoryPath, sessionsPath } from '../config/paths.ts';
import { peersOf, remoteFailureCause, runPeer as runFleetPeer } from '../fleet/transport.ts';
import { type IdentityCache, sessionIdentities, stableIdentity } from '../session/identity.ts';
import {
  type SessionIdentity,
  type WhoisAnswer,
  WhoisAnswerSchema,
  type WhoisEvent,
  WhoisEventSchema,
  type WhoisList,
  WhoisListSchema,
  type WhoisMachine,
} from '../session/identitySchema.ts';
import { loadSessions } from '../session/registry.ts';
import {
  type MachineWhois,
  machineAsked,
  readQuestion,
  settleWhois,
  whoisHere,
} from '../session/whois.ts';
import type { MachineConfig, Session } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { printLine } from '../util/stdout.ts';
import { alignedLines, tableLines } from '../util/table.ts';
import { parseFlags, UsageError } from './flags.ts';
import { usageLine } from './help.ts';

/**
 * `ccmux whois` — which session a window title, a provider's conversation id or an address is.
 *
 * Every machine answers for its own sessions, because only it can read its registry and the
 * provider files beside it; this command asks each and puts the answers together. A machine that
 * did not answer is named, and "not found" beside one is exit 2, not 1: its sessions were not
 * looked at.
 */

const PEER_TIMEOUT_MS = 30_000;
const PEER_CONNECT_SECONDS = 5;

/** How another machine is asked. A parameter so the fleet half is tested without a fleet. */
export type PeerRunner = typeof runFleetPeer;

type Asked<T> = { machine: WhoisMachine; answer: T | null };

async function askPeer<T>(
  machinesOf: (answer: T) => string[],
  m: MachineConfig,
  peer: { machine: string; alias: string | null },
  args: string[],
  read: (stdout: string) => T,
  runPeer: PeerRunner,
): Promise<Asked<T>> {
  const lost = (error: string): Asked<T> => ({
    machine: { machine: peer.machine, status: 'unavailable', error },
    answer: null,
  });
  const result = await runPeer(
    m,
    peer.machine,
    peer.alias,
    ['ccmux', 'whois', '--local', ...args],
    {
      timeoutMs: PEER_TIMEOUT_MS,
      connectTimeoutSeconds: PEER_CONNECT_SECONDS,
    },
  );
  if (result.transportFailed) return lost(result.failureDetail ?? 'not reachable right now');
  let answer: T;
  try {
    answer = read(result.stdout);
  } catch {
    const cause = remoteFailureCause(result.stderr) ?? remoteFailureCause(result.stdout);
    return lost(
      `no whois answer (exit ${result.code}): ${cause ?? 'nothing reported'} — is ccmux there older than this command?`,
    );
  }
  // A session is addressed by the machine it is on; an answer naming another is not this one's.
  if (machinesOf(answer).some((machine) => machine !== peer.machine))
    return lost('the answer came from a different machine than the one asked');
  return { machine: { machine: peer.machine, status: 'asked' }, answer };
}

/** This machine and each peer, or the one machine the question names. */
function targets(m: MachineConfig, only: string | null, local: boolean) {
  const peers = local ? [] : peersOf(m);
  const all = [m.rcPrefix, ...peers.map((peer) => peer.machine)];
  return { peers, machines: only === null ? all : [only] };
}

const unknownMachine = (machine: string): WhoisMachine => ({
  machine,
  status: 'unavailable',
  error: 'not a machine of this fleet (see ccmux fleet)',
});

export async function whoisFleet(
  m: MachineConfig,
  query: string,
  opts: { local: boolean; sessions?: readonly Session[]; runPeer?: PeerRunner } = { local: false },
): Promise<WhoisAnswer> {
  const question = readQuestion(query);
  const { peers, machines } = targets(m, machineAsked(question), opts.local);
  const asked = await Promise.all(
    machines.map(async (machine): Promise<Asked<MachineWhois>> => {
      if (machine === m.rcPrefix)
        return {
          machine: { machine, status: 'asked' },
          answer: await whoisHere(m, question, opts.sessions),
        };
      const peer = peers.find((candidate) => candidate.machine === machine);
      if (peer === undefined) return { machine: unknownMachine(machine), answer: null };
      return askPeer(
        (answer: MachineWhois) => [
          ...answer.candidates.map((row) => row.session.machine),
          ...(answer.conversation === null ? [] : [answer.conversation.machine]),
        ],
        m,
        peer,
        ['--json', '--', query],
        (stdout): MachineWhois => {
          const answer = WhoisAnswerSchema.parse(JSON.parse(stdout));
          return { candidates: answer.candidates, conversation: answer.conversation };
        },
        opts.runPeer ?? runFleetPeer,
      );
    }),
  );
  return settleWhois(
    query,
    asked.flatMap((row) => (row.answer === null ? [] : [row.answer])),
    asked.map((row) => row.machine),
  );
}

export async function whoisAll(
  m: MachineConfig,
  opts: { local: boolean; sessions?: readonly Session[]; runPeer?: PeerRunner } = { local: false },
): Promise<WhoisList> {
  const { peers, machines } = targets(m, null, opts.local);
  const asked = await Promise.all(
    machines.map(async (machine): Promise<Asked<SessionIdentity[]>> => {
      if (machine === m.rcPrefix)
        return {
          machine: { machine, status: 'asked' },
          answer: await sessionIdentities(m, opts.sessions ?? loadSessions(m)),
        };
      const peer = peers.find((candidate) => candidate.machine === machine);
      if (peer === undefined) return { machine: unknownMachine(machine), answer: null };
      return askPeer(
        (sessions: SessionIdentity[]) => sessions.map((session) => session.machine),
        m,
        peer,
        ['--all', '--json'],
        (stdout) => WhoisListSchema.parse(JSON.parse(stdout)).sessions,
        opts.runPeer ?? runFleetPeer,
      );
    }),
  );
  return {
    sessions: asked.flatMap((row) => row.answer ?? []),
    machines: asked.map((row) => row.machine),
  };
}

/**
 * The identities of this machine's sessions as they change.
 *
 * Every session is sent once when the stream opens, so a consumer needs no separate first read and
 * cannot fall between one and the other. After that a session is sent again when anything but its
 * activity times differs, and `gone` when it leaves the registry. Changes are noticed by watching
 * the two files that record them — the registry and the daemon's inventory — with a slow re-read
 * underneath, because a lost file event would otherwise leave a consumer holding a session's old
 * directory or id with nothing ever correcting it.
 */
export function followIdentities(
  m: MachineConfig,
  emit: (event: WhoisEvent) => void,
  opts: { recheckMs?: number; sessions?: () => readonly Session[] } = {},
): () => void {
  const cache: IdentityCache = new Map();
  const sent = new Map<string, { stable: string; identity: SessionIdentity }>();
  let running = false;
  let again = false;
  let stopped = false;
  const pass = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const now = await sessionIdentities(m, opts.sessions?.() ?? loadSessions(m), cache);
        if (stopped) return;
        const seen = new Set<string>();
        for (const identity of now) {
          seen.add(identity.name);
          const stable = stableIdentity(identity);
          if (sent.get(identity.name)?.stable === stable) continue;
          sent.set(identity.name, { stable, identity });
          emit({ event: 'session', session: identity });
        }
        for (const [name, last] of sent) {
          if (seen.has(name)) continue;
          sent.delete(name);
          emit({ event: 'gone', address: last.identity.address, machine: m.rcPrefix, name });
        }
      } while (again && !stopped);
    } finally {
      running = false;
    }
  };
  const watched = new Set([basename(sessionsPath(m)), basename(inventoryPath(m))]);
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    mkdirSync(m.stateDir, { recursive: true });
    // The directory, not the files: both are replaced by rename, which leaves a file watcher
    // holding an inode nobody writes to any more.
    watcher = watch(m.stateDir, (_event, filename) => {
      if (filename === null || watched.has(filename)) void pass();
    });
  } catch {
    watcher = null;
  }
  const timer = setInterval(() => void pass(), opts.recheckMs ?? 30_000);
  void pass();
  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}

const ago = (at: string | null, now: number): string =>
  at === null ? '-' : `${humanizeDuration(Math.max(0, now - Date.parse(at)) / 1000)} ago`;

const liveness = (session: SessionIdentity): string =>
  session.archived
    ? 'archived'
    : session.running === null
      ? 'state unknown'
      : session.running
        ? 'running'
        : 'stopped';

export function identityLines(session: SessionIdentity, now: number): string[] {
  const lives = session.conversations.length;
  return [
    `${session.address}  ${session.provider}  ${liveness(session)}`,
    ...alignedLines([
      ['  title', session.title],
      ['  dir', session.dir],
      ['  repository', session.repository ?? '-'],
      [
        '  conversation',
        `${session.conversation}${lives > 1 ? `  (the newest of ${lives} this session has lived in)` : ''}`,
      ],
      ['  created', session.createdAt ?? '-'],
      ['  last active', ago(session.lastActivityAt, now)],
    ]),
  ];
}

function machineLines(machines: readonly WhoisMachine[]): string[] {
  return machines.flatMap((row) =>
    row.status === 'unavailable' ? [`NOT asked: ${row.machine} — ${row.error}`] : [],
  );
}

export function answerLines(answer: WhoisAnswer, now: number): string[] {
  const lines: string[] = [];
  if (answer.session !== null) lines.push(...identityLines(answer.session, now));
  else if (answer.conversation !== null) {
    const stray = answer.conversation;
    lines.push(
      `no managed session reads ${stray.id}; the conversation is kept on ${stray.machine}`,
      ...alignedLines([
        ['  open with', `ccmux transcript ${stray.address} --json`],
        ['  title', stray.title ?? '-'],
        ['  dir', stray.dir ?? '-'],
        ['  repository', stray.repository ?? '-'],
      ]),
    );
  } else if (answer.found === 'ambiguous')
    lines.push(
      `'${answer.query}' fits ${answer.candidates.length} sessions; none is chosen:`,
      ...answer.candidates.map((row) => `  ${row.session.address}  (by ${row.by})`),
    );
  else lines.push(`'${answer.query}' is not a ccmux session`);
  return [...lines, ...machineLines(answer.machines)];
}

export function listLines(list: WhoisList, now: number): string[] {
  const rows = list.sessions.map((session) => [
    session.address,
    session.provider,
    session.repository ?? '-',
    session.title,
    String(session.conversations.length),
    ago(session.lastActivityAt, now),
  ]);
  return [
    ...tableLines(['ADDRESS', 'AGENT', 'REPOSITORY', 'TITLE', 'LIVES', 'ACTIVE'], rows),
    ...machineLines(list.machines),
  ];
}

/** The published shape of every answer this command gives, for a consumer that reads by schema. */
export function whoisSchemas(): Record<string, unknown> {
  return {
    answer: z.toJSONSchema(WhoisAnswerSchema),
    list: z.toJSONSchema(WhoisListSchema),
    event: z.toJSONSchema(WhoisEventSchema),
  };
}

async function follow(m: MachineConfig, json: boolean): Promise<number> {
  // Written directly: `console.log` swallows the EPIPE of a reader that left, and a follower whose
  // consumer is gone must end rather than watch for ever.
  const stop = followIdentities(m, (event) => {
    const line = json
      ? JSON.stringify(event)
      : event.event === 'gone'
        ? `gone     ${event.address}`
        : `session  ${event.session.address}  ${event.session.conversation}  ${event.session.repository ?? '-'}  ${event.session.dir}`;
    process.stdout.write(`${line}\n`);
  });
  await new Promise<void>((resolve) => {
    const end = (): void => {
      stop();
      resolve();
    };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
    process.stdout.on('error', end);
  });
  return 0;
}

export async function cmdWhois(args: string[]): Promise<number> {
  const flags = parseFlags('whois', args, [0, 1]);
  const json = flags.bool('json');
  const local = flags.bool('local');
  const query = flags.positionals[0];
  const modes = [
    flags.bool('all'),
    flags.bool('follow'),
    flags.bool('schema'),
    query !== undefined,
  ];
  if (modes.filter(Boolean).length !== 1)
    throw new UsageError(
      `ask about one thing: a title, address or conversation id — or --all, --follow, --schema\n${usageLine('whois')}`,
    );
  if (flags.bool('schema')) {
    await printLine(JSON.stringify(whoisSchemas()));
    return 0;
  }
  const m = loadMachineConfig();
  if (flags.bool('follow')) return follow(m, json);
  if (flags.bool('all')) {
    const list = await whoisAll(m, { local });
    for (const line of json ? [JSON.stringify(list)] : listLines(list, Date.now()))
      await printLine(line);
    return 0;
  }
  const answer = await whoisFleet(m, query as string, { local });
  for (const line of json ? [JSON.stringify(answer)] : answerLines(answer, Date.now()))
    await printLine(line);
  if (answer.found === 'session' || answer.found === 'conversation') return 0;
  return answer.found === 'none' && answer.machines.some((row) => row.status === 'unavailable')
    ? 2
    : 1;
}

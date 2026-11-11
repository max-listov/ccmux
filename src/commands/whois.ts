import { mkdirSync, watch } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { SESSION_ENV } from '../agent/launch/identityEnv.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { inventoryPath, sessionsPath } from '../config/paths.ts';
import { selfAddress } from '../fleet/address.ts';
import {
  type Asked,
  askPeer,
  FROM_ANOTHER_MACHINE,
  NOT_IN_FLEET,
  type PeerRunner,
} from '../fleet/askPeer.ts';
import { loadPeerHeld, PackedSchema, unpack } from '../fleet/peerDelta.ts';
import { type Peer, peersOf } from '../fleet/transport.ts';
import { type IdentityCache, sessionIdentities, stableIdentity } from '../session/identity.ts';
import {
  type SessionIdentity,
  SessionIdentitySchema,
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
/** How long after one machine's answer it is asked again by a follower. */
const PEER_EVERY_MS = 15_000;

type AskOpts = { local: boolean; sessions?: readonly Session[]; runPeer?: PeerRunner };

/** One machine's part of an answer, with the machine as the answer reports it. */
type Part<T> = { machine: WhoisMachine; answer: T | null };

const part = <T>(asked: Asked<T>, machinesOf: (answer: T) => string[]): Part<T> => {
  const lost = (error: string): Part<T> => ({
    machine: { machine: asked.machine, status: 'unavailable', error },
    answer: null,
  });
  if (!asked.ok) return lost(asked.error);
  // A session is addressed by the machine it is on; an answer naming another is not this one's.
  if (machinesOf(asked.answer).some((machine) => machine !== asked.machine))
    return lost(FROM_ANOTHER_MACHINE);
  return { machine: { machine: asked.machine, status: 'asked' }, answer: asked.answer };
};

const ask = <T>(
  m: MachineConfig,
  peer: Pick<Peer, 'machine' | 'alias'>,
  argv: string[],
  read: (stdout: string) => T,
  runPeer: PeerRunner | undefined,
  signal?: AbortSignal,
): Promise<Asked<T>> =>
  askPeer(m, peer, argv, read, {
    what: 'whois',
    timeoutMs: PEER_TIMEOUT_MS,
    connectTimeoutSeconds: PEER_CONNECT_SECONDS,
    runPeer,
    signal,
  });

/** This machine and each peer, or the one machine the question names. */
function targets(m: MachineConfig, only: string | null, local: boolean) {
  const peers = local ? [] : peersOf(m);
  const all = [m.rcPrefix, ...peers.map((peer) => peer.machine)];
  return { peers, machines: only === null ? all : [only] };
}

const unknownMachine = (machine: string): WhoisMachine => ({
  machine,
  status: 'unavailable',
  error: NOT_IN_FLEET,
});

export async function whoisFleet(
  m: MachineConfig,
  query: string,
  opts: AskOpts = { local: false },
): Promise<WhoisAnswer> {
  const question = readQuestion(query);
  const { peers, machines } = targets(m, machineAsked(question), opts.local);
  const asked = await Promise.all(
    machines.map(async (machine): Promise<Part<MachineWhois>> => {
      if (machine === m.rcPrefix)
        return {
          machine: { machine, status: 'asked' },
          answer: await whoisHere(m, question, opts.sessions),
        };
      const peer = peers.find((candidate) => candidate.machine === machine);
      if (peer === undefined) return { machine: unknownMachine(machine), answer: null };
      return part(
        await ask(
          m,
          peer,
          ['ccmux', 'whois', '--local', '--json', '--', query],
          (stdout): MachineWhois => {
            const answer = WhoisAnswerSchema.parse(JSON.parse(stdout));
            return { candidates: answer.candidates, conversation: answer.conversation };
          },
          opts.runPeer,
        ),
        (answer) => [
          ...answer.candidates.map((row) => row.session.machine),
          ...(answer.conversation === null ? [] : [answer.conversation.machine]),
        ],
      );
    }),
  );
  return settleWhois(
    query,
    asked.flatMap((row) => (row.answer === null ? [] : [row.answer])),
    asked.map((row) => row.machine),
  );
}

const machinesOfSessions = (sessions: SessionIdentity[]): string[] =>
  sessions.map((session) => session.machine);

export async function whoisAll(
  m: MachineConfig,
  opts: AskOpts = { local: false },
): Promise<WhoisList> {
  const { peers, machines } = targets(m, null, opts.local);
  const asked = await Promise.all(
    machines.map(async (machine): Promise<Part<SessionIdentity[]>> => {
      if (machine === m.rcPrefix)
        return {
          machine: { machine, status: 'asked' },
          answer: await sessionIdentities(m, opts.sessions ?? loadSessions(m)),
        };
      const peer = peers.find((candidate) => candidate.machine === machine);
      if (peer === undefined) return { machine: unknownMachine(machine), answer: null };
      return part(
        await ask(
          m,
          peer,
          ['ccmux', 'whois', '--local', '--all', '--json'],
          (stdout) => WhoisListSchema.parse(JSON.parse(stdout)).sessions,
          opts.runPeer,
        ),
        machinesOfSessions,
      );
    }),
  );
  return {
    sessions: asked.flatMap((row) => row.answer ?? []),
    machines: asked.map((row) => row.machine),
  };
}

const PeerIdentitiesSchema = z.object({ machine: z.string().min(1), sessions: PackedSchema });

/** One machine's sessions as its daemon keeps them, asked by change: what this reader already holds
 *  comes back as a digest, so a question every few seconds carries almost nothing. */
async function peerIdentities(
  m: MachineConfig,
  peer: Pick<Peer, 'machine' | 'alias'>,
  runPeer: PeerRunner | undefined,
  signal: AbortSignal,
): Promise<Part<SessionIdentity[]>> {
  const held = loadPeerHeld(peer.machine, 'identities');
  return part(
    await ask(
      m,
      peer,
      ['ccmux', '_peer-read', 'identities', ...held.knownArgs],
      (stdout) => {
        const answer = PeerIdentitiesSchema.parse(JSON.parse(stdout));
        const rows = unpack(answer.sessions, held.rows);
        if (rows === null) throw new Error('a row the reader does not hold came back as a digest');
        held.save([answer.sessions]);
        return z.array(SessionIdentitySchema).parse(rows);
      },
      runPeer,
      signal,
    ),
    machinesOfSessions,
  );
}

/**
 * The identities of the fleet's sessions as they change.
 *
 * Every session of a machine is sent once when that machine first answers, then a `machine` line
 * says the machine has been read — so a consumer needs no separate first read and cannot fall
 * between one and the stream. After that a session is sent again when anything but its activity
 * times differs, and `gone` when it leaves its machine's registry.
 *
 * This machine is watched: the two files that record a change — the registry and the daemon's
 * inventory — with a slow re-read underneath, because a lost file event would otherwise leave a
 * consumer holding a session's old directory or id with nothing ever correcting it. Every other
 * machine is asked again a fixed time after it last answered, by change, of its daemon. A machine
 * that stops answering is said so once, with the reason, and its sessions are NOT called gone: they
 * were not looked at. What left while it was away is said when it answers again.
 */
export function followIdentities(
  m: MachineConfig,
  emit: (event: WhoisEvent) => void,
  opts: {
    recheckMs?: number;
    peerEveryMs?: number;
    sessions?: () => readonly Session[];
    /** Only this machine. */
    local?: boolean;
    runPeer?: PeerRunner;
  } = {},
): () => void {
  const cache: IdentityCache = new Map();
  /** What was last said of each session, by address — a name is one machine's. */
  const sent = new Map<string, { stable: string; identity: SessionIdentity }>();
  const standing = new Map<string, string>();
  let stopped = false;
  /** Ends the questions still on their way when the follower stops. */
  const leaving = new AbortController();
  /** One machine's sessions as they now are: say what changed, and what is no longer there. */
  const settle = (machine: string, now: readonly SessionIdentity[]): void => {
    const seen = new Set<string>();
    for (const identity of now) {
      seen.add(identity.address);
      const stable = stableIdentity(identity);
      if (sent.get(identity.address)?.stable === stable) continue;
      sent.set(identity.address, { stable, identity });
      emit({ event: 'session', session: identity });
    }
    for (const [address, last] of sent) {
      if (last.identity.machine !== machine || seen.has(address)) continue;
      sent.delete(address);
      emit({ event: 'gone', address, machine, name: last.identity.name });
    }
  };
  /** Said when a machine's standing changes, and only then. */
  const stand = (row: WhoisMachine): void => {
    const now = JSON.stringify(row);
    if (standing.get(row.machine) === now) return;
    standing.set(row.machine, now);
    emit({ event: 'machine', ...row });
  };

  let running = false;
  let again = false;
  const pass = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        try {
          const now = await sessionIdentities(m, opts.sessions?.() ?? loadSessions(m), cache);
          if (stopped) return;
          settle(m.rcPrefix, now);
          stand({ machine: m.rcPrefix, status: 'asked' });
        } catch (error) {
          // A registry caught mid-write is read again on the next pass; the stream goes on.
          if (stopped) return;
          stand({
            machine: m.rcPrefix,
            status: 'unavailable',
            error: error instanceof Error ? error.message : String(error),
          });
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

  // Each machine in its own loop, the next question only after the last was answered: a machine
  // slower than the interval is asked less often, never twice at once.
  const waits = new Set<ReturnType<typeof setTimeout>>();
  const follow = async (peer: Peer): Promise<void> => {
    while (!stopped) {
      let asked: Part<SessionIdentity[]>;
      try {
        asked = await peerIdentities(m, peer, opts.runPeer, leaving.signal);
      } catch (error) {
        // Whatever went wrong asking, the machine was not read; the next round asks again.
        asked = {
          machine: {
            machine: peer.machine,
            status: 'unavailable',
            error: error instanceof Error ? error.message : String(error),
          },
          answer: null,
        };
      }
      if (stopped) return;
      if (asked.answer !== null) settle(peer.machine, asked.answer);
      stand(asked.machine);
      await new Promise<void>((resolve) => {
        const wait = setTimeout(() => {
          waits.delete(wait);
          resolve();
        }, opts.peerEveryMs ?? PEER_EVERY_MS);
        waits.add(wait);
      });
    }
  };
  if (opts.local !== true) for (const peer of peersOf(m)) void follow(peer);
  return () => {
    stopped = true;
    leaving.abort();
    clearInterval(timer);
    for (const wait of waits) clearTimeout(wait);
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
      ['  project', session.project ?? '-'],
      ...(session.checkouts ?? []).map((checkout): [string, string] => [
        checkout.current ? '  here' : '  also',
        `${checkout.dir}  ${checkout.role}  ${checkout.repository ?? '-'}`,
      ]),
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
        ['  project', stray.project ?? '-'],
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
    session.project ?? '-',
    session.title,
    String(session.conversations.length),
    ago(session.lastActivityAt, now),
  ]);
  return [
    ...tableLines(['ADDRESS', 'AGENT', 'REPOSITORY', 'PROJECT', 'TITLE', 'LIVES', 'ACTIVE'], rows),
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

async function follow(m: MachineConfig, json: boolean, local: boolean): Promise<never> {
  // Written directly: `console.log` swallows the EPIPE of a reader that left, and a follower whose
  // consumer is gone must end rather than watch for ever.
  const say = (event: WhoisEvent): string =>
    event.event === 'gone'
      ? `gone     ${event.address}`
      : event.event === 'machine'
        ? event.status === 'asked'
          ? `machine  ${event.machine}  read`
          : `machine  ${event.machine}  NOT asked — ${event.error}`
        : `session  ${event.session.address}  ${event.session.conversation}  ${event.session.repository ?? '-'}  ${event.session.project ?? '-'}  ${event.session.dir}`;
  const stop = followIdentities(
    m,
    (event) => process.stdout.write(`${json ? JSON.stringify(event) : say(event)}\n`),
    { local },
  );
  await new Promise<void>((resolve) => {
    const end = (): void => {
      stop();
      resolve();
    };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
    process.stdout.on('error', end);
  });
  // A question to another machine may still be in flight, and its process would hold this one
  // open until it timed out: a follower nobody reads has nothing left to wait for.
  process.exit(0);
}

export async function cmdWhois(args: string[]): Promise<number> {
  const flags = parseFlags('whois', args, [0, 1]);
  const json = flags.bool('json');
  const local = flags.bool('local');
  // No question from inside a session is the session asking about itself.
  const self =
    process.env[SESSION_ENV] !== undefined &&
    flags.positionals.length === 0 &&
    !flags.bool('all') &&
    !flags.bool('follow') &&
    !flags.bool('schema');
  const query = self ? process.env[SESSION_ENV] : flags.positionals[0];
  const modes = [
    flags.bool('all'),
    flags.bool('follow'),
    flags.bool('schema'),
    query !== undefined,
  ];
  if (modes.filter(Boolean).length !== 1)
    throw new UsageError(
      `ask about one thing: a title, address or conversation id — or --all, --follow, --schema; with no question, a session is told about itself\n${usageLine('whois')}`,
    );
  if (flags.bool('schema')) {
    await printLine(JSON.stringify(whoisSchemas()));
    return 0;
  }
  const m = loadMachineConfig();
  if (flags.bool('follow')) return follow(m, json, local);
  if (flags.bool('all')) {
    const list = await whoisAll(m, { local });
    for (const line of json ? [JSON.stringify(list)] : listLines(list, Date.now()))
      await printLine(line);
    return 0;
  }
  const answer = await whoisFleet(m, self ? selfAddress(m, query as string) : (query as string), {
    local: local || self,
  });
  for (const line of json ? [JSON.stringify(answer)] : answerLines(answer, Date.now()))
    await printLine(line);
  if (answer.found === 'session' || answer.found === 'conversation') return 0;
  return answer.found === 'none' && answer.machines.some((row) => row.status === 'unavailable')
    ? 2
    : 1;
}

import { SESSION_ENV } from '../agent/launch/identityEnv.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { selfAddress } from '../fleet/address.ts';
import type {
  SessionIdentity,
  WhoisAnswer,
  WhoisEvent,
  WhoisList,
  WhoisMachine,
} from '../session/identitySchema.ts';
import { followIdentities, whoisAll, whoisFleet } from '../session/whoisFleet.ts';
import type { MachineConfig } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { printLine } from '../util/stdout.ts';
import { alignedLines, tableLines } from '../util/table.ts';
import { COMMAND_SCHEMAS } from './answerSchemas.ts';
import { parseFlags, UsageError } from './flags.ts';
import { usageLine } from './help.ts';

/** `ccmux whois` — reads the command line and prints what `session/whoisFleet.ts` answers. */

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
    await printLine(JSON.stringify(COMMAND_SCHEMAS.whois()));
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

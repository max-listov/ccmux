import { loadMachineConfig } from '../config/machine.ts';
import { followEvents, readEvents } from '../events/feed.ts';
import type { SessionEvent } from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { parseFlags } from './flags.ts';

/**
 * `ccmux events` — the contract an outside surface reads the feed through.
 *
 * The file format is deliberately NOT the contract. A consumer that parsed `events.jsonl` itself
 * would have to know about rotation, about partially-written last lines, and about where the state
 * directory is on that machine — three things that are ours to change and none of which it should
 * ever have to learn. It also could not be run over a transport: `ccmux events --follow` works the
 * same locally and through whatever runs a command on another machine, which is what makes one
 * consumer able to watch a whole fleet.
 *
 * `--since` is a TIME, and the events it returns are at-least-once by design: reconnecting re-reads
 * the boundary instant rather than risking a gap. Every event carries `id` for exactly that reason —
 * a consumer that acts on events drops the ids it has already handled.
 */
const HUMAN: Record<SessionEvent['event'], string> = {
  'turn-start': 'started a turn',
  'turn-end': 'finished a turn',
  waiting: 'is waiting at a menu',
  resumed: 'left the menu and went back to work',
  'session-start': 'session started',
  'session-stop': 'session stopped',
  'session-blocked': 'session is blocked',
  inventory: 'is now',
};

/** One event as a line a person can read. Pure, so the wording is testable and cannot drift from
 *  the machine-readable shape it describes. */
export function formatEvent(event: SessionEvent): string {
  const when = event.ts.slice(11, 19);
  const address = `${event.machine}:${event.session}`;
  if (event.event === 'inventory')
    return `${when}  ${address.padEnd(24)} ${
      event.row == null
        ? 'left the inventory'
        : `${HUMAN.inventory} ${event.row.state}${event.row.model === null ? '' : ` · ${event.row.model}`}`
    }`;
  const parts = [HUMAN[event.event]];
  if (event.durationMs !== undefined)
    parts.push(`after ${humanizeDuration(Math.round(event.durationMs / 1000))}`);
  if (event.interrupted === true) parts.push('(interrupted — it did not end on its own)');
  if (event.detail !== undefined && event.detail !== '') parts.push(`— ${event.detail}`);
  return `${when}  ${address.padEnd(24)} ${parts.join(' ')}`;
}

/**
 * One event wrapped for a transport that resumes.
 *
 * Some transports carry a follow-style feed as **framed** NDJSON rather than raw bytes: each line is
 * an envelope whose `data` is the payload and whose `cursor` marks where the reader got to, so a
 * broken stream can be reopened from that point instead of from the beginning or from now. The
 * envelope shape is fixed and strict on the other side — extra keys are a protocol error, not a
 * courtesy — so this builds exactly it and nothing more.
 *
 * The cursor is the event's own timestamp, which is precisely what `--since` takes: whatever a reader
 * hands back, it is asking the same question in the same units. Duplicates at the boundary are
 * expected (delivery is at-least-once by design) and are dropped by `id`.
 */
export function framedLine(event: SessionEvent): string {
  return `${JSON.stringify({ data: `${JSON.stringify(event)}\n`, cursor: event.ts })}\n`;
}

/**
 * Where the transport hands back a resume point: the variable `--cursor-env` names.
 *
 * A stream that has no natural end is capped by a deadline, so it is reopened on a schedule, and
 * on every lost lane. On reopen the transport passes the cursor the reader got to through the
 * producer's ENVIRONMENT, not through its arguments, because the node profile refuses
 * caller-supplied arguments. Which variable is the transport's choice, so the profile that runs this
 * command says it — the static argv is the profile owner's, not the caller's.
 *
 * A producer that reads the wrong variable starts from "now" and nothing fails: the stream opens,
 * frames flow, and everything that happened during the gap is silently absent. That happened here —
 * a fixed name this command read was never the one the transport set, so no reconnect ever resumed.
 * Naming the variable where the transport is configured is what makes the two agree.
 */
export function resumeCursor(
  name: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return name === undefined ? undefined : env[name];
}

/**
 * Which instant to resume from. An explicit `--since` wins: it is a person asking a deliberate
 * question, while the variable is a transport mechanism, and the person must be able to override
 * the machine. Pure, so both precedence and the empty-string case are testable.
 */
export function resolveSince(
  explicit: string | undefined,
  fromEnv: string | undefined,
): string | undefined {
  if (explicit !== undefined) return explicit;
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
}

export async function cmdEvents(args: string[]): Promise<number> {
  const flags = parseFlags('events', args, [0, 0]);
  const follow = flags.bool('follow');
  const json = flags.bool('json');
  // Kept separate from `--json` on purpose: `--json` is the clean stream of events, which is what a
  // person reads and what a local consumer wants. Wrapping every line in an envelope by default
  // would make the common case pay for the transport's contract.
  const framed = flags.bool('framed');
  let since = flags.str('since');
  const cursorEnv = flags.str('cursor-env');
  if (cursorEnv === '') {
    console.error('events: --cursor-env needs the name of an environment variable');
    return 1;
  }
  const session = flags.str('session');
  const limit = flags.int('n');
  const explicitSince = since;
  since = resolveSince(since, resumeCursor(cursorEnv));
  if (since !== undefined && !Number.isFinite(Date.parse(since))) {
    // Loud, deliberately — including when it came from the environment. The transport only ever
    // hands back a cursor this same producer emitted, so an unparseable one is a defect somewhere,
    // and the alternative (ignore it, start from "now") is precisely the silent gap this reads the
    // variable to close.
    const source = explicitSince === undefined ? `${cursorEnv} carried` : '--since needs';
    console.error(
      `events: ${source} an ISO instant (e.g. ${new Date().toISOString()}), got '${since}'`,
    );
    return 1;
  }

  const m = loadMachineConfig();
  // `process.stdout.write`, deliberately not `console.log`: measured, console.log SWALLOWS the EPIPE
  // a closed reader produces, so a follower whose consumer had gone away kept watching the feed
  // forever. Writing directly surfaces the error, which is what turns "reader left" into an exit.
  const emit = (event: SessionEvent): void => {
    if (framed) {
      process.stdout.write(framedLine(event));
      return;
    }
    process.stdout.write(`${json ? JSON.stringify(event) : formatEvent(event)}\n`);
  };

  if (!follow) {
    const opts: Parameters<typeof readEvents>[1] = {};
    if (since !== undefined) opts.since = since;
    if (session !== undefined) opts.session = session;
    if (limit !== undefined) opts.limit = limit;
    else if (since === undefined) opts.limit = 30; // a bare call is a look at recent history, not a dump
    for (const event of readEvents(m, opts)) emit(event);
    return 0;
  }

  // Follow never returns on its own: the caller ends it by closing the pipe or killing the process,
  // which is how every long-running reader in a pipeline behaves.
  const opts: Parameters<typeof followEvents>[2] = {};
  if (since !== undefined) opts.since = since;
  if (session !== undefined) opts.session = session;
  const stop = followEvents(m, emit, opts);
  const done = new Promise<void>((resolve) => {
    const end = (): void => {
      stop();
      resolve();
    };
    process.on('SIGINT', end);
    process.on('SIGTERM', end);
    // A reader that went away is noticed on the next WRITE, not the moment it left: a closed pipe is
    // only observable by writing into it — measured, `destroyed`/`writable`/`close` all stay quiet
    // until then. So this behaves like every other follow tool, and the handler's real job is to
    // make that moment a clean exit instead of an unhandled EPIPE crash.
    process.stdout.on('error', end);
  });
  await done;
  return 0;
}

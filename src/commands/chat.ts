import { existsSync, readdirSync } from 'node:fs';
import { fmtRow, machineColumnWidth } from '../chat/fleetLog.ts';
import { followLog, type LogFrame, parseCursor, ZERO_CURSOR } from '../chat/logFeed.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { archiveDir } from '../config/paths.ts';
import { chatLogAnswer } from '../fleet/chatLog.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { setSessionChatEnabled } from '../session/registry.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { printLine } from '../util/stdout.ts';
import { COMMAND_SCHEMAS } from './answerSchemas.ts';
import { resolveSince, resumeCursor } from './events.ts';
import { type ParsedFlags, parseFlags } from './flags.ts';

const USAGE =
  'usage: ccmux chat <log [-n N] [--fleet] [--json] | log --follow [--since <cursor>] [--cursor-env <NAME>] [--json|--framed]\n             | on <name> | off <name> | default <name>>';

/**
 * `ccmux chat log --follow` — the log as a stream a consumer can resume, instead of a snapshot it
 * has to take again and again.
 *
 * Deliberately LOCAL, and the fan-out lives where it already works. A machine's chat log is its own
 * two files, so a fleet feed is N local feeds; the transport that carries one carries N, and that is
 * how the session event feed reaches a dashboard today. Holding N long-lived remote commands open
 * inside ccmux would rebuild a stream multiplexer that exists one layer down, and would make a
 * cursor mean N positions on N clocks instead of one position in one file.
 *
 * `--fleet` therefore stays what it is: a snapshot, for first paint. The feed owns what happens next.
 */
async function cmdChatFeed(m: MachineConfig, flags: ParsedFlags): Promise<number> {
  const json = flags.bool('json');
  const framed = flags.bool('framed');
  let since = flags.str('since');
  // The variable the transport hands a resume point back in — see `resumeCursor` in events.ts.
  const cursorEnv = flags.str('cursor-env');
  if (cursorEnv === '') {
    console.error('chat log: --cursor-env needs the name of an environment variable');
    return 1;
  }
  const explicit = since;
  since = resolveSince(since, resumeCursor(cursorEnv));

  let cursor = ZERO_CURSOR;
  if (since !== undefined) {
    const parsed = parseCursor(since);
    if ('error' in parsed) {
      // Loud, including when it came from the environment: a cursor is only ever handed back by this
      // same producer, so a bad one is a defect. Ignoring it and starting from "now" is the failure
      // with no symptom — the stream opens, rows flow, and the gap simply does not exist.
      const source =
        explicit === undefined
          ? `${cursorEnv} carried an unusable cursor`
          : '--since needs a cursor';
      console.error(`chat log: ${source} — ${parsed.error}`);
      return 1;
    }
    cursor = parsed.cursor;
  }

  // `process.stdout.write`, not console.log: console.log swallows the EPIPE a departed reader
  // produces, and a follower whose consumer has gone must exit rather than watch forever.
  const emit = (frame: LogFrame): void => {
    if (framed) {
      // The envelope the transport resumes on: `data` is the payload, `cursor` is where the reader
      // got to. Fixed and strict on the other side, so this builds exactly it and nothing more.
      process.stdout.write(
        `${JSON.stringify({ data: `${JSON.stringify(frame)}\n`, cursor: frame.cursor })}\n`,
      );
      return;
    }
    process.stdout.write(`${json || framed ? JSON.stringify(frame) : fmtFrame(frame)}\n`);
  };

  const stop = followLog(m, cursor, emit);
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

/** One frame as a line a person can read. */
function fmtFrame(frame: LogFrame): string {
  if (frame.kind === 'machine') {
    return frame.machine.ok
      ? `[${frame.cursor}] ${frame.machine.machine}: watching`
      : `[${frame.cursor}] ${frame.machine.machine}: ${frame.machine.error ?? 'unavailable'}`;
  }
  return `[${frame.cursor}] ${fmtRow(frame.row)}`;
}

async function cmdChatLog(m: MachineConfig, flags: ParsedFlags): Promise<number> {
  if (flags.bool('schema')) {
    await printLine(JSON.stringify(COMMAND_SCHEMAS['chat log']()));
    return 0;
  }
  if (flags.bool('follow')) return cmdChatFeed(m, flags);
  const limit = flags.int('n') ?? 30;
  const { machines, rows } = await chatLogAnswer(m, { limit, fleet: flags.bool('fleet') });

  if (flags.bool('json')) {
    // Emitted THROUGH the schema, so the shape a peer parses and the shape we print are one
    // definition rather than two that can drift.
    await printLine(JSON.stringify({ machines, rows }));
    return 0;
  }
  // Unreachable notices go to stderr so the row stream stays pipeable on stdout.
  for (const s of machines) if (!s.ok) console.error(`(${s.machine}: ${s.error})`);
  if (rows.length === 0) {
    // An empty log with an archive beside it is the one case where silence misleads: the exchange
    // DID happen, it simply predates the current record generation. The fact is known here, so it is
    // said here — otherwise the next person concludes the log is broken and goes looking.
    console.log(`(chat log empty)${archivedNote(m)}`);
    return 0;
  }
  const width = machineColumnWidth(machines);
  for (const row of rows) console.log(fmtRow(row, width));
  return 0;
}

/**
 * Chat administration + inspection:
 *   ccmux chat log [-n N]    — this machine's exchange (received + sent), tail of N (default 30)
 *   ccmux chat log --fleet   — the same, merged with every other machine's log, in time order
 *   ccmux chat log --json    — machine-readable; also the remote transport format `--fleet` reads from peers
 *   ccmux chat on  <name>     — enable inter-agent chat for this session
 *   ccmux chat off <name>     — disable it for this session
 *   ccmux chat default <name> — clear the override; inherit the machine's chatEnabled
 */
export async function cmdChat(args: string[]): Promise<number> {
  const flags = parseFlags('chat', args, [1, 2]);
  const sub = flags.positionals[0];
  const m = loadMachineConfig();

  if (sub === 'log') return cmdChatLog(m, flags);

  if (sub === 'on' || sub === 'off' || sub === 'default') {
    const target = flags.positionals[1];
    if (target === undefined) {
      console.log(
        `usage: ccmux chat ${sub} <name>   ·   <machine>:<name> for another fleet machine`,
      );
      return 1;
    }
    const fwd = await forwardIfRemote(target, 'chat', [], { m, verbArgs: [sub] });
    if (fwd.done) return fwd.code;
    const name = fwd.session;
    const ok = await setSessionChatEnabled(m, name, sub === 'default' ? undefined : sub === 'on');
    if (!ok) {
      console.log(`no such session: ${name}`);
      return 1;
    }
    log.info({ msg: 'chat toggled', name, enabled: sub === 'default' ? null : sub === 'on' });
    // Chat framing + the Stop hook are LAUNCH-time (see claude/launch.ts settingsArg) — so, like
    // `ccmux mode` and `ccmux router`, this only takes effect on the next restart. Saying so here is
    // the difference between "it works" and "I toggled it and nothing happened".
    const state =
      sub === 'default'
        ? `default (${m.chatEnabled ? 'enabled' : 'disabled'})`
        : sub === 'on'
          ? 'enabled'
          : 'disabled';
    console.log(`${name}: chat ${state} — applies on: ccmux restart ${name}`);
    if (sub === 'on' || (sub === 'default' && m.chatEnabled)) {
      console.log(
        `  then: ccmux msg ${name} "…" --task <name>   ·   mail waits for its turn to end`,
      );
      console.log(`  restarting the whole fleet at once: ccmux restart --all`);
    }
    return 0;
  }

  console.log(USAGE);
  return sub === undefined ? 0 : 1;
}

/** One clause naming the archive when the live log is empty but superseded records exist. Read-only
 *  and best-effort: a note about history must never be able to fail the command that prints it. */
function archivedNote(m: MachineConfig): string {
  try {
    const dir = archiveDir(m);
    if (!existsSync(dir)) return '';
    const count = readdirSync(dir).length;
    return count === 0
      ? ''
      : ` — ${count} superseded file(s) from an earlier record generation are kept in ${dir}`;
  } catch {
    return '';
  }
}

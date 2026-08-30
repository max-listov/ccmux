import { existsSync, readdirSync } from 'node:fs';
import { z } from 'zod';
import {
  fmtRow,
  type LogMachine,
  LogPayloadSchema,
  type LogRow,
  LogRowSchema,
  localRows,
  machineColumnWidth,
  mergeFleetLog,
} from '../chat/fleetLog.ts';
import {
  followRows,
  type LogFrame,
  machineFrame,
  parseCursor,
  ZERO_CURSOR,
} from '../chat/logFeed.ts';
import { loadLedger } from '../chat/store.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { archiveDir } from '../config/paths.ts';
import { setSessionChatEnabled } from '../config/sessions.ts';
import { loadOutboxAcked } from '../fleet/flush.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { loadOutbox } from '../fleet/outbox.ts';
import { peersOf, runPeer } from '../fleet/transport.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';

const USAGE =
  'usage: ccmux chat <log [-n N] [--fleet] [--json] | log --follow [--since <cursor>] [--json|--framed]\n             | on <name> | off <name> | default <name>>';

/** Where the transport hands back a resume point when it reopens a capped stream. The same variable
 *  the session feed reads, because it is the transport's mechanism and not this feed's. */
const RESUME_CURSOR_ENV = 'STITCHWIRE_STREAM_CURSOR';

interface Source {
  machine: LogMachine;
  rows: LogRow[];
}

/** What we require of a peer's answer before looking at individual rows: just "it has a rows list".
 *  Everything stricter is applied per row, so one bad line is not a lost machine. */
const RemoteEnvelopeSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).default([]),
});

/** The marker the wire puts on an answer it had to cut at its stream cap. */
const TRUNCATION_MARKER = 'output truncated';

/**
 * Why a peer's answer could not be read.
 *
 * A cut document and an old build produce the same `JSON.parse` failure and are nothing alike: one
 * is fixed by asking for less, the other by upgrading a machine. Saying "older ccmux?" about a
 * message that was simply too long sends the reader to the wrong place entirely — and this snapshot
 * serialises whole message bodies, so it is the failure that actually happens.
 */
export function unreadableReason(stdout: string, stderr: string): string {
  if (stderr.includes(TRUNCATION_MARKER)) {
    return `answer was cut at the transport's cap (${stdout.length} bytes arrived) — ask for fewer rows with -n, or follow the feed instead: ccmux chat log --follow`;
  }
  // A cut answer that carried no marker still betrays itself: it is large AND it does not close.
  const looksCut = stdout.length > 64 * 1024 && !stdout.trimEnd().endsWith('}');
  if (looksCut) {
    return `answer arrived incomplete (${stdout.length} bytes, no closing brace) — ask for fewer rows with -n, or follow the feed instead: ccmux chat log --follow`;
  }
  return 'unreadable log output (older ccmux?)';
}

/** Ask every OTHER machine for its own log. The remote call deliberately omits `--fleet`, so the
 *  recursion is impossible by construction rather than by a guard. An unreachable machine is a row,
 *  not a failure: with no server-to-server keys, transit exists only while the owner is connected.
 *
 *  Asked through `runPeer`, so a machine reachable only over the wire is asked at all. Reading the
 *  ssh map directly meant a wire-only peer was not unreachable in the view — it was ABSENT from it,
 *  which reads as a machine where nothing has ever happened. */
async function remoteLogs(m: MachineConfig, limit: number): Promise<Source[]> {
  const others = peersOf(m).filter((p) => p.machine !== m.rcPrefix);
  return Promise.all(
    others.map(async ({ machine, alias }): Promise<Source> => {
      const fail = (error: string): Source => ({
        machine: { machine, ok: false, error },
        rows: [],
      });
      const r = await runPeer(
        m,
        machine,
        alias,
        ['ccmux', 'chat', 'log', '-n', String(limit), '--json'],
        { timeoutMs: 20_000 },
      );
      if (r.transportFailed) return fail(r.failureDetail ?? 'unreachable (no transit right now)');
      if (r.code !== 0) return fail(`remote ccmux failed (exit ${r.code})`);
      try {
        const envelope = RemoteEnvelopeSchema.safeParse(JSON.parse(r.stdout)).data;
        if (envelope === undefined) return fail(unreadableReason(r.stdout, r.stderr));
        // Row-by-row, so ONE malformed line from a peer costs that line and not the peer's whole
        // history — the same leniency the local ledger loader already applies to its own file.
        // Trust OUR label for the machine, not the peer's self-report: the merged view exists to be
        // copied into an address, and the address that works is the one from this machine's map.
        const rows = envelope.rows.flatMap((row) => {
          const parsedRow = LogRowSchema.safeParse({ ...row, machine }).data;
          return parsedRow === undefined ? [] : [parsedRow];
        });
        return { machine: { machine, ok: true, error: null }, rows };
      } catch {
        return fail(unreadableReason(r.stdout, r.stderr));
      }
    }),
  );
}

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
async function cmdChatFeed(m: MachineConfig, args: string[]): Promise<number> {
  let json = false;
  let framed = false;
  let since: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--follow' || a === '-f') continue;
    else if (a === '--json') json = true;
    else if (a === '--framed') framed = true;
    else if (a === '--since') since = args[++i];
    else if (a?.startsWith('-')) {
      console.error(`chat log: unknown flag '${a}'\n${USAGE}`);
      return 1;
    }
  }
  const explicit = since;
  const fromEnv = process.env[RESUME_CURSOR_ENV];
  if (since === undefined && fromEnv !== undefined && fromEnv !== '') since = fromEnv;

  let cursor = ZERO_CURSOR;
  if (since !== undefined) {
    const parsed = parseCursor(since);
    if ('error' in parsed) {
      // Loud, including when it came from the environment: a cursor is only ever handed back by this
      // same producer, so a bad one is a defect. Ignoring it and starting from "now" is the failure
      // with no symptom — the stream opens, rows flow, and the gap simply does not exist.
      const source =
        explicit === undefined
          ? `${RESUME_CURSOR_ENV} carried an unusable cursor`
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

  // Identity first, so a reader can attribute every row that follows without being told separately
  // which machine it opened — and so a stream that is alive but quiet is distinguishable from one
  // that never opened.
  emit(machineFrame(m.rcPrefix, cursor));
  const stop = followRows(m, cursor, emit);
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

async function cmdChatLog(m: MachineConfig, args: string[]): Promise<number> {
  if (args.includes('--follow') || args.includes('-f')) return cmdChatFeed(m, args);
  const nIdx = args.indexOf('-n');
  const parsed = nIdx >= 0 ? Number.parseInt(args[nIdx + 1] ?? '', 10) : 30;
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  // Both halves of the exchange: what arrived (ledger) AND what we sent elsewhere (outbox) — the
  // initiator's side is exactly what was missing when a hand-off went to the wrong machine.
  const self: Source = {
    machine: { machine: m.rcPrefix, ok: true, error: null },
    rows: localRows(m.rcPrefix, loadLedger(m), loadOutbox(m), loadOutboxAcked(m)),
  };
  // A peer is always asked WITHOUT `--fleet` (see remoteLogs), so answering about ourselves here is
  // what makes the wire format the same shape as the human-facing one.
  const sources = args.includes('--fleet') ? [self, ...(await remoteLogs(m, limit))] : [self];
  const machines = sources.map((s) => s.machine);
  const rows = mergeFleetLog(sources, limit);

  if (args.includes('--json')) {
    // Emitted THROUGH the schema, so the shape a peer parses and the shape we print are one
    // definition rather than two that can drift.
    console.log(JSON.stringify(LogPayloadSchema.parse({ machines, rows })));
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
 *   ccmux chat log --json    — machine-readable; also the wire format `--fleet` reads from peers
 *   ccmux chat on  <name>     — enable inter-agent chat for this session
 *   ccmux chat off <name>     — disable it for this session
 *   ccmux chat default <name> — clear the override; inherit the machine's chatEnabled
 */
export async function cmdChat(args: string[]): Promise<number> {
  const sub = args[0];
  const m = loadMachineConfig();

  if (sub === 'log') return cmdChatLog(m, args.slice(1));

  if (sub === 'on' || sub === 'off' || sub === 'default') {
    const target = args[1];
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
        `  then: ccmux msg ${name} "…" --task <name>   ·   --defer waits for its turn to end`,
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

import { existsSync } from 'node:fs';
import { escalationRefusal } from '../agent/claude/launch.ts';
import { providerFor } from '../agent/index.ts';
import { envFilePath, envInput, inheritedEnvInput } from '../agent/launch/launchInputs.ts';
import { launchInputsFor } from '../agent/launch/launchStamp.ts';
import { inheritsUndeclaredEnv } from '../agent/launch/sessionEnv.ts';
import { loadAckedIds } from '../chat/ackLog.ts';
import { CursorsUnreadableError, loadCursors } from '../chat/cursors.ts';
import { holdReason, STALLED_HOLD_MS } from '../chat/holdReason.ts';
import { managedPeer } from '../chat/identity.ts';
import { loadLedger, unreadableCount } from '../chat/ledger.ts';
import { unreadFor } from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { APP_BUNDLE, CACHE_DIR, chatAuthPath, DATA_DIR } from '../config/paths.ts';
import { remoteAdapterSocketPath } from '../fleet/remoteAdapter.ts';
import { checkFleet, peersOf } from '../fleet/transport.ts';
import { collectRows } from '../inventory/rows.ts';
import { loadSessions } from '../session/registry.ts';
import { readChatHold, readLaunchStamp } from '../session/status.ts';
import type { MachineConfig } from '../types.ts';
import { HOME, PLATFORM, promptInvocation, SELF_DISPLAY, UID } from '../util/env.ts';
import { run } from '../util/spawn.ts';
import { VERSION } from '../util/version.ts';

/** Sessions currently stranded at a blocking menu. Read through the same row builder `list` uses,
 *  so the two can never disagree about who is waiting. */
async function sessionsAtPrompt(m: MachineConfig): Promise<{ name: string; question: string }[]> {
  const rows = await collectRows(m);
  return rows
    .filter((r) => r.atPrompt !== null)
    .map((r) => ({ name: r.session.name, question: r.atPrompt as string }));
}

/** Whether the file the boot unit and the PATH shim launch is actually on disk. Checked because a
 *  version number proves nothing here: the process holding this code was loaded from a path that may
 *  no longer exist, and it will keep answering until the day it is asked to start again. */
function bundlePresent(): boolean {
  return existsSync(APP_BUNDLE);
}

/** Is the boot daemon registered + running? launchd on macOS, systemd on Linux. */
async function daemonState(
  os: NodeJS.Platform,
  bootLabel: string,
): Promise<{ manager: string | null; state: string }> {
  if (os === 'darwin') {
    const { code, stdout } = await run(['launchctl', 'list']);
    if (code !== 0) return { manager: 'launchd', state: 'unknown' };
    const active = stdout.split('\n').some((l) => l.trim().endsWith(bootLabel));
    return { manager: 'launchd', state: active ? 'active' : 'inactive' };
  }
  if (os === 'linux') {
    const { stdout } = await run(['systemctl', 'is-active', bootLabel]);
    return { manager: 'systemd', state: stdout.trim() || 'unknown' };
  }
  return { manager: null, state: 'unknown' };
}

/**
 * Everything `doctor` checks, as one value.
 *
 * Both outputs render THIS. The JSON used to be a separate object built part-way through and returned
 * early, so the checks written after it — stalled mail, unreadable ledger records, sessions stranded at
 * a menu, unreadable cursors — reached the human and never the machine: an agent reading `--json` was
 * told everything was fine exactly when a person reading the text was told it was not.
 */
export interface DoctorReport {
  version: string;
  generatedAt: string;
  os: NodeJS.Platform;
  self: string;
  promptInvocation: string;
  configFile: string;
  mutedChat: string[];
  unhonourableModes: string[];
  stateDir: string;
  dataDir: string;
  cacheDir: string;
  bundle: { path: string; present: boolean };
  rcPrefix: string;
  bootLabel: string;
  bins: { claude: string; codex: string | null; tmux: string };
  deps: { claude: boolean; codex: boolean; tmux: boolean };
  fleet: Awaited<ReturnType<typeof checkFleet>>;
  fleetSelfLabelled: boolean;
  remoteTransport: { socket: string; ready: boolean } | null;
  sessionEnv: EnvOrigin[];
  sessionEnvMigrationPending: number;
  launchInputs: InputOrigin[];
  daemon: { manager: string | null; state: string };
  chat: {
    /** Mail held past the stall threshold; null when it could not be determined (see `problem`). */
    stalled: { session: string; reason: string }[] | null;
    /** Ledger records this build cannot read; null when the ledger itself could not be read. */
    unreadableRecords: number | null;
    /** What stopped a chat check from answering — unreadable cursors hold delivery outright. */
    problems: string[];
  };
  /** Sessions stranded at a menu; null when that could not be read (no usable tmux here). */
  atPrompt: { name: string; question: string }[] | null;
}

export async function buildDoctorReport(m: MachineConfig): Promise<DoctorReport> {
  const daemon = await daemonState(PLATFORM, m.bootLabel);
  // The fleet map is verified for both outputs: a mis-mapped alias is the single failure that
  // silently delivers mail to the wrong machine, and the reader least able to eyeball a warning is
  // the agent reading JSON.
  const fleet = m.fleet ?? {};
  const peers = peersOf(m);
  const fleetChecks = peers.length > 0 ? await checkFleet(m) : [];
  // A label equal to OUR OWN prefix can never be reached: `routeFor` resolves it locally first.
  const selfLabelled = Object.keys(fleet).includes(m.rcPrefix);
  // The wire has one prerequisite ssh does not: a LOCAL agent holding this machine's connection.
  const remoteSocket = remoteAdapterSocketPath(m);
  const remoteExpected = peers.some((p) => p.via === 'remote');
  const inherited = envOrigins(m);
  const problems: string[] = [];
  let stalled: DoctorReport['chat']['stalled'] = null;
  try {
    stalled = stalledMail(m);
  } catch (e) {
    // The one failure here that stops delivery outright is named; anything else leaves the answer
    // unknown (null) rather than empty, which would read as "nothing is stalled".
    problems.push(
      e instanceof CursorsUnreadableError ? e.message : `stalled mail unknown: ${String(e)}`,
    );
  }
  let unreadableRecords: number | null = null;
  try {
    unreadableRecords = unreadableCount(loadLedger(m));
  } catch (e) {
    problems.push(`the ledger could not be read: ${String(e)}`);
  }
  // Read through tmux, so it can only be answered where tmux runs: a doctor that cannot find tmux
  // reports that (`deps.tmux`) instead of failing on the way to asking it something.
  let atPrompt: DoctorReport['atPrompt'] = null;
  try {
    atPrompt = existsSync(m.tmuxBin) ? await sessionsAtPrompt(m) : null;
  } catch {
    atPrompt = null;
  }
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    os: PLATFORM,
    self: SELF_DISPLAY,
    promptInvocation: promptInvocation(),
    configFile: process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`,
    mutedChat: mutedChatSessions(m),
    unhonourableModes: unhonourableModes(m, UID === 0),
    stateDir: m.stateDir,
    dataDir: DATA_DIR,
    cacheDir: CACHE_DIR,
    bundle: { path: APP_BUNDLE, present: bundlePresent() },
    rcPrefix: m.rcPrefix,
    bootLabel: m.bootLabel,
    bins: { claude: m.claudeBin, codex: m.codexBin ?? null, tmux: m.tmuxBin },
    deps: {
      claude: existsSync(m.claudeBin),
      codex: m.codexBin ? existsSync(m.codexBin) : false,
      tmux: existsSync(m.tmuxBin),
    },
    fleet: fleetChecks,
    fleetSelfLabelled: selfLabelled,
    remoteTransport: remoteExpected
      ? { socket: remoteSocket, ready: existsSync(remoteSocket) }
      : null,
    // Names, never values — an agent reading this is exactly the consumer that would otherwise
    // paste a secret somewhere.
    sessionEnv: inherited,
    sessionEnvMigrationPending: inherited.filter((o) => o.kind === 'inherited').length,
    launchInputs: externalInputOrigins(m),
    daemon,
    chat: { stalled, unreadableRecords, problems },
    atPrompt,
  };
}

/** Sessions on this machine with mail the daemon has been holding past the point where a hold is a
 *  moment. Read-only: the same records `inbox` reads, asked once per session. */
export function stalledMail(m: MachineConfig): { session: string; reason: string }[] {
  const out: { session: string; reason: string }[] = [];
  const ledger = loadLedger(m);
  const cursors = loadCursors(m);
  const acked = loadAckedIds(m);
  for (const s of loadSessions(m)) {
    if (s.archived) continue;
    const hold = readChatHold(s.name);
    if (hold === null || hold.heldForMs < STALLED_HOLD_MS) continue;
    const unread = unreadFor(managedPeer(m.rcPrefix, s), ledger, cursors, acked);
    const first = unread[0];
    if (first === undefined) continue; // held about something already delivered since
    out.push({
      session: s.name,
      reason: holdReason(first.msg, {
        recipient: s,
        chatEnabled: chatEnabledFor(s, m),
        running: true,
        nowMs: Date.now(),
        chatDeliverable: providerFor(s).inspectChatPane !== undefined,
        daemonHold: hold,
      }).text,
    });
  }
  return out;
}

/**
 * Which chat-enabled sessions cannot actually send.
 *
 * Sending is authenticated by a capability handed to the session at launch; a session started before
 * that existed keeps running and keeps RECEIVING, so nothing looks wrong until someone tries to reply
 * and hits a refusal. Asked here as a FACT about the machine rather than inferred from a stamp: the
 * capability either exists for that session or it does not.
 */
export function mutedChatSessions(m: MachineConfig): string[] {
  return loadSessions(m)
    .filter((s) => chatEnabledFor(s, m) && !s.archived && !existsSync(chatAuthPath(m, s.name)))
    .map((s) => s.name);
}

/**
 * Settings that can never take effect on this machine.
 *
 * A hand-edited config can still ask for an escalated mode under a root daemon; the launcher
 * downgrades it, and without this the box would look configured one way while behaving another —
 * the exact confusion that cost a live server an hour.
 */
export function unhonourableModes(m: MachineConfig, isRoot: boolean): string[] {
  const out: string[] = [];
  if (escalationRefusal(m.permissionMode, isRoot, m.allowEscalatedUnderRoot) !== null)
    out.push(`machine default '${m.permissionMode}'`);
  for (const s of loadSessions(m)) {
    if (
      s.permissionMode !== undefined &&
      escalationRefusal(s.permissionMode, isRoot, m.allowEscalatedUnderRoot) !== null
    ) {
      out.push(`${s.name} → '${s.permissionMode}'`);
    }
  }
  return out;
}

/**
 * Where a session's environment comes from — and whether any session is still living on the old
 * accident.
 *
 * The accident: `_run` is a Bun process whose cwd is the session directory, the runtime loaded that
 * directory's `.env` into itself, and the launcher copied its environment into the agent — so a
 * project's secrets reached the agent AND every process it spawned, undeclared. Measured before the
 * fix, on a live fleet: 5 of 14 sessions were carrying project variables that way, API keys among
 * them.
 *
 * Now the pane runs with `--no-env-file` and the launch recipe subtracts those names, so a NEW launch
 * only gets what the session declares. A session started before that shipped still carries the old
 * environment until it restarts — which is exactly what this section reports, because "it is fixed in
 * the code" and "it is fixed on this machine" are different claims and only the second one matters.
 *
 * NAMES only, never values: a name answers the question ("is this session carrying project
 * variables"), while a value would put the secret into a diagnostic people paste into chats.
 */
export interface EnvOrigin {
  name: string;
  /** `declared` — the session names its own file. `inherited` — it is still running on an undeclared
   *  one and will lose those variables when it restarts. */
  kind: 'declared' | 'inherited';
  paths: readonly string[];
  keys: readonly string[];
  /** The file changed after this session launched — it is running yesterday's values. */
  drifted: boolean;
  /** A declared file that is not there. The session still starts; this is how anyone finds out. */
  missing: boolean;
}

export function envOrigins(m: MachineConfig): EnvOrigin[] {
  const out: EnvOrigin[] = [];
  for (const s of loadSessions(m)) {
    if (s.archived) continue;
    const stamped = readLaunchStamp(s.name)?.inputs?.env;
    const declared = envFilePath(s);
    if (declared !== null) {
      const input = envInput(s);
      out.push({
        name: s.name,
        kind: 'declared',
        paths: [declared],
        keys: input.keys ?? [],
        drifted: stamped !== undefined && stamped !== null && stamped !== input.digest,
        missing: input.digest === null,
      });
      continue;
    }
    // Undeclared: the shared predicate decides, so this report and `env-file --adopt` are always
    // about the same set of sessions.
    if (!inheritsUndeclaredEnv(s, readLaunchStamp(s.name), process.env.NODE_ENV)) continue;
    const inherited = inheritedEnvInput(s.dir, process.env.NODE_ENV);
    out.push({
      name: s.name,
      kind: 'inherited',
      paths: inherited.paths,
      keys: inherited.keys ?? [],
      drifted: stamped != null && stamped !== inherited.digest,
      missing: false,
    });
  }
  return out;
}

/**
 * The external files agents read at startup, grouped BY REASON rather than by session.
 *
 * Grouping matters more than it looks: on a normal machine every session shares one global rule set
 * but each project brings its own MCP file, so a per-origin listing printed one line per project and
 * buried the rest of the report. Per reason, the report says the two things a person needs — how many
 * sessions this input shapes, and whether they are all looking at the same thing.
 */
export interface InputOrigin {
  reason: string;
  sessions: number;
  /** How many DIFFERENT configurations of this input exist across those sessions. */
  variants: number;
  /** One representative, so the reader knows which files are meant. */
  example: string;
}

export function externalInputOrigins(m: MachineConfig): InputOrigin[] {
  const byReason = new Map<string, { sessions: number; labels: Set<string>; example: string }>();
  for (const s of loadSessions(m)) {
    if (s.archived) continue;
    for (const input of launchInputsFor(s, m)) {
      if (input.reason === 'env') continue; // reported in full by envOrigins, with its own warning
      const hit = byReason.get(input.reason);
      if (hit === undefined)
        byReason.set(input.reason, {
          sessions: 1,
          labels: new Set([input.label]),
          example: input.label,
        });
      else {
        hit.sessions += 1;
        hit.labels.add(input.label);
      }
    }
  }
  return [...byReason.entries()]
    .map(([reason, v]) => ({
      reason,
      sessions: v.sessions,
      variants: v.labels.size,
      example: v.example,
    }))
    .sort((a, b) => a.reason.localeCompare(b.reason));
}

const NAME_SAMPLE = 8;

/** `FOO, BAR, … (+12 more)` — enough to recognise what is being carried without printing a wall. */
export function sampleNames(keys: readonly string[]): string {
  const shown = keys.slice(0, NAME_SAMPLE).join(', ');
  return keys.length > NAME_SAMPLE ? `${shown} (+${keys.length - NAME_SAMPLE} more)` : shown;
}

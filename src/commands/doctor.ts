import { existsSync } from 'node:fs';
import { escalationRefusal } from '../agent/claude/launch.ts';
import { providerFor } from '../agent/index.ts';
import { envFilePath, envInput, inheritedEnvInput } from '../agent/launchInputs.ts';
import { launchInputsFor } from '../agent/launchStamp.ts';
import { inheritsUndeclaredEnv } from '../agent/sessionEnv.ts';
import { readChatHold, readLaunchStamp } from '../agent/sessionStatus.ts';
import { holdReason, STALLED_HOLD_MS } from '../chat/holdReason.ts';
import { managedPeer } from '../chat/identity.ts';
import {
  loadAckedIds,
  loadCursors,
  loadLedger,
  unreadableCount,
  unreadFor,
} from '../chat/store.ts';
import { chatEnabledFor } from '../config/chat.ts';
import { loadMachineConfig } from '../config/machine.ts';
import { APP_BUNDLE, CACHE_DIR, chatAuthPath, DATA_DIR } from '../config/paths.ts';
import { loadSessions } from '../config/sessions.ts';
import { HOME, PLATFORM, promptInvocation, SELF_DISPLAY, UID } from '../env.ts';
import { checkFleet, peersOf } from '../fleet/transport.ts';
import { wireSocketPath } from '../fleet/wire.ts';
import type { MachineConfig } from '../types.ts';
import { run } from '../util/spawn.ts';
import { VERSION } from '../util/version.ts';
import { collectRows } from './list.ts';

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

export async function cmdDoctor(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const m = loadMachineConfig();
  const configFile = process.env.CCMUX_CONFIG ?? `${HOME}/.config/ccmux/machine.json`;
  const claudeOk = existsSync(m.claudeBin);
  const codexOk = m.codexBin ? existsSync(m.codexBin) : false;
  const tmuxOk = existsSync(m.tmuxBin);
  const daemon = await daemonState(PLATFORM, m.bootLabel);
  // Verify the fleet map for BOTH outputs. It used to run only on the human path, so the one consumer
  // that cannot eyeball a warning — an agent reading `--json` — was the one kept in the dark about a
  // mis-mapped alias, which is the single failure that silently delivers mail to the wrong machine.
  const fleet = m.fleet ?? {};
  const peers = peersOf(m);
  const fleetChecks = peers.length > 0 ? await checkFleet(m) : [];
  // A machine label that equals OUR OWN prefix can never be reached: `routeFor` resolves it locally
  // first (it must — ssh to ourselves lands in a different ccmux). Cloned configs make this easy to
  // do by accident, and the symptom is the original incident: a reply "to the other box" delivered
  // to a local same-named session.
  const selfLabelled = Object.keys(fleet).includes(m.rcPrefix);
  // The wire has one prerequisite ssh does not: a LOCAL agent holding this machine's connection.
  // Without it every wire peer reads as "unreachable", which sends the reader looking at the far
  // machine for a fault that is on this one.
  const wireSocket = wireSocketPath(m);
  const wireExpected = peers.some((p) => p.via === 'wire');
  const wireReady = wireSocket !== null && existsSync(wireSocket);
  // What shapes these sessions besides argv: the agents' external files, and the environment the
  // supervisor's own runtime mixes in from each session directory. Both were invisible until now,
  // and the second one is the reason this section exists at all.
  const inherited = envOrigins(m);
  const external = externalInputOrigins(m);

  if (json) {
    console.log(
      JSON.stringify({
        version: VERSION,
        generatedAt: new Date().toISOString(),
        os: PLATFORM,
        self: SELF_DISPLAY,
        promptInvocation: promptInvocation(),
        configFile,
        mutedChat: mutedChatSessions(m),
        unhonourableModes: unhonourableModes(m, UID === 0),
        stateDir: m.stateDir,
        dataDir: DATA_DIR,
        cacheDir: CACHE_DIR,
        bundle: { path: APP_BUNDLE, present: bundlePresent() },
        rcPrefix: m.rcPrefix,
        bootLabel: m.bootLabel,
        bins: { claude: m.claudeBin, codex: m.codexBin ?? null, tmux: m.tmuxBin },
        deps: { claude: claudeOk, codex: codexOk, tmux: tmuxOk },
        fleet: fleetChecks,
        fleetSelfLabelled: selfLabelled,
        wire: wireExpected ? { socket: wireSocket, ready: wireReady } : null,
        // Names, never values — an agent reading this is exactly the consumer that would otherwise
        // paste a secret somewhere.
        sessionEnv: inherited,
        sessionEnvMigrationPending: inherited.filter((o) => o.kind === 'inherited').length,
        launchInputs: external,
        daemon,
      }),
    );
    return 0;
  }

  console.log(`ccmux ${VERSION}`);
  console.log(`self:       ${SELF_DISPLAY}`);
  console.log(`agent cli:  ${promptInvocation()}`);
  // The three roots, named, because "where does this thing keep its files" used to be answerable
  // only by hunting through a home directory — and the answer differed per machine.
  console.log(`config:     ${configFile}`);
  console.log(`state:      ${m.stateDir}`);
  console.log(`code:       ${DATA_DIR}`);
  console.log(`cache:      ${CACHE_DIR}`);
  console.log(`rc prefix:  ${m.rcPrefix}`);
  console.log(`boot label: ${m.bootLabel}`);
  console.log(`claude: ${m.claudeBin} (${claudeOk ? 'ok' : 'missing'})`);
  console.log(
    `codex:  ${m.codexBin ?? '—'} (${m.codexBin ? (codexOk ? 'ok' : 'missing') : 'not set'})`,
  );
  console.log(`tmux:   ${m.tmuxBin} (${tmuxOk ? 'ok' : 'missing'})`);
  if (fleetChecks.length > 0) {
    console.log('fleet:');
    for (const c of fleetChecks) {
      const mark = c.ok ? 'ok' : c.reachable ? 'PROBLEM' : 'unreachable';
      const route = c.via === 'wire' ? 'via wire' : `→ ${c.alias}`;
      console.log(`  ${c.machine} ${route} (${mark})${c.ok ? '' : ` — ${c.detail}`}`);
    }
    if (selfLabelled) {
      console.log(
        `  PROBLEM — '${m.rcPrefix}' is this machine's own rcPrefix, so '${m.rcPrefix}:<session>' always resolves LOCALLY and that entry is dead. Give each machine a distinct rcPrefix.`,
      );
    }
  }
  if (wireExpected) {
    console.log(
      `wire:   ${wireReady ? `agent socket ${wireSocket}` : `PROBLEM — no agent socket at ${wireSocket ?? '(unknown)'}; start 'stitchwire agent' on this machine`}`,
    );
  }
  const unhonourable = unhonourableModes(m, UID === 0);
  if (unhonourable.length > 0) {
    console.log(`perms:  PROBLEM — configured but impossible here: ${unhonourable.join(', ')}`);
    console.log(`        ${escalationRefusal('bypassPermissions', true) ?? ''}`);
  }
  const muted = mutedChatSessions(m);
  if (muted.length > 0) {
    console.log(
      `chat:   PROBLEM — ${muted.length} session(s) can receive but NOT send (started before the send capability existed): ${muted.join(', ')}`,
    );
    console.log(
      `        fix: ccmux restart ${muted[0]}   (the capability is handed out at launch)`,
    );
  }
  // Mail that is held rather than delivered is invisible from the sending side by construction: the
  // send succeeded, and everything after that happens on this machine. A stall therefore has to be
  // findable HERE, or it is findable nowhere — which is how a message sat behind a parked composer
  // for eleven hours while three more were sent on top of it.
  try {
    const stuck = stalledMail(m);
    if (stuck.length > 0) {
      console.log(
        `chat:   ${stuck.length} message(s) held longer than ${Math.round(STALLED_HOLD_MS / 60_000)} minutes and not delivered:`,
      );
      for (const s of stuck) console.log(`        ${s.session} — ${s.reason}`);
      console.log(
        `        the mail is not lost; nothing will move it until that condition clears. See: ccmux inbox <session>`,
      );
    }
  } catch {
    // diagnosis is a courtesy — never fail the check that reports it
  }
  // A skipped record must be VISIBLE somewhere prominent. The reader steps over what a newer build
  // wrote so the whole ledger does not fall over during an upgrade — but an append-only history that
  // quietly looks shorter than it is has stopped being one, so the count is reported here.
  try {
    const unreadable = unreadableCount(loadLedger(m));
    if (unreadable > 0) {
      console.log(
        `chat:   ${unreadable} ledger record(s) this ccmux cannot read — written by a newer build.`,
      );
      console.log(
        `        Not an error and nothing is lost: they are stepped over, their positions kept, and this machine reads them once it is upgraded.`,
      );
    }
  } catch (e) {
    console.log(`chat:   PROBLEM — the ledger could not be read: ${String(e)}`);
  }
  if (external.length > 0) {
    console.log(
      'inputs: what shapes a session besides argv (hashed; a change here shows in RESTART)',
    );
    for (const o of external) {
      const spread = o.variants > 1 ? `, ${o.variants} distinct configurations, e.g.` : ' —';
      console.log(`        ${o.reason.padEnd(6)} ${o.sessions} session(s)${spread} ${o.example}`);
    }
  }
  const stillInheriting = inherited.filter((o) => o.kind === 'inherited');
  const declaredEnv = inherited.filter((o) => o.kind === 'declared');
  if (declaredEnv.length > 0) {
    console.log(`env:    ${declaredEnv.length} session(s) declare an env file:`);
    for (const o of declaredEnv) {
      const note = o.missing
        ? ' — MISSING; the session starts without it'
        : o.drifted
          ? ' — file changed since launch, restart to pick it up'
          : '';
      console.log(`        ${o.name} — ${o.keys.length} name(s) from ${o.paths.join(', ')}${note}`);
    }
  }
  if (stillInheriting.length > 0) {
    // A PROBLEM because it is one, and a FINITE one: these are sessions started before the recipe
    // shipped. Naming the exact command to end it is the difference between a report and a chore.
    console.log(
      `env:    PROBLEM — ${stillInheriting.length} session(s) still run on an UNDECLARED env file from their own directory:`,
    );
    for (const o of stillInheriting) {
      console.log(
        `        ${o.name} — ${o.keys.length} name(s) from ${o.paths.join(', ')}${o.drifted ? ' (file changed since launch — the session still has the old values)' : ''}`,
      );
      if (o.keys.length > 0) console.log(`          ${sampleNames(o.keys)}`);
    }
    console.log(
      '        These were started before the environment became a declared recipe: the runtime loaded those files',
    );
    console.log(
      '        into the supervisor and the launcher passed them to the agent — and to every process it spawns.',
    );
    console.log(
      '        A restart now would take them away, so declare them first if they are needed:',
    );
    console.log(
      '        fix: ccmux env-file --adopt --dry-run   (then without --dry-run, then restart)',
    );
    console.log('        Names only are shown here; values are never read into any diagnostic.');
  }
  const waiting = await sessionsAtPrompt(m);
  if (waiting.length > 0) {
    console.log(
      `prompt: PROBLEM — ${waiting.length} session(s) sitting at a menu, unable to act until it is answered:`,
    );
    for (const w of waiting) console.log(`        ${w.name} — ${w.question}`);
    console.log(
      "        These read as 'idle' to every other signal. Answer in the pane, or set trustPrompt in machine.json so the supervisor answers the ones it is allowed to.",
    );
  }
  if (!bundlePresent()) {
    console.log(
      `bundle: PROBLEM — nothing at ${APP_BUNDLE}, which is what the boot unit and the 'ccmux' shim both launch.`,
    );
    console.log(
      '        A running daemon serves from memory, so the fleet looks healthy until something restarts it.',
    );
    console.log(
      '        fix: ccmux update   (restores it), or reinstall: curl -fsSL <releaseUrl>/../install.sh | bash',
    );
  }
  console.log(`daemon: ${daemon.state}${daemon.manager ? ` (${daemon.manager})` : ''}`);
  return 0;
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

import { existsSync } from 'node:fs';
import { prettyModel } from '../agent/format.ts';
import type { PaneScan } from '../agent/index.ts';
import {
  lastActivityMs,
  lastTranscriptMessage,
  providerFor,
  sessionModel,
  sessionUsedTokens,
} from '../agent/index.ts';
import { envFilePath } from '../agent/launchInputs.ts';
import { computeStamp, staleReasons } from '../agent/launchStamp.ts';
import {
  type LifecycleStatus,
  readLaunchStamp,
  readLifecycle,
  readMetrics,
  readWaiting,
  resolveLiveState,
} from '../agent/sessionStatus.ts';
import { assistantEndedCurrentTurn, turnState } from '../chat/turnState.ts';
import { readLifecycleBlockForSession } from '../config/lifecycleBlocks.ts';
import { loadMachineConfig, rcName } from '../config/machine.ts';
import { releaseStanding } from '../config/releaseCheck.ts';
import { loadSessions } from '../config/sessions.ts';
import { promptInvocation } from '../env.ts';
import { lastSignOfLife } from '../events/observe.ts';
import { paneWorkingSince } from '../events/paneActivity.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { PlanLimits } from '../runtime/planLimits.ts';
import type { NativeAccount } from '../runtime/projectionSchema.ts';
import { managedRuntimeView } from '../runtime/view.ts';
import { capturePane, listSessionsCreated } from '../tmux/tmux.ts';
import { fmtTokens } from '../tui/format.ts';
import type {
  ContextInfo,
  ListItem,
  ListJson,
  MachineConfig,
  Session,
  SessionState,
  TranscriptMessage,
} from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { VERSION } from '../util/version.ts';
import { accountLines } from './accounts.ts';

// Last pane scan per session — lets the TUI skip the `tmux capture-pane` FORK for cards that
// aren't visible (off-screen state is invisible anyway; it refreshes the moment it scrolls in).
// Keyed by session name; cleared when a session stops so a restart always re-captures.
const scanCache = new Map<string, PaneScan>();

/** One session's resolved status — the single data shape consumed by both the CLI
 *  (`cmdList`) and the live TUI. */
export interface ListRow {
  session: Session;
  running: boolean;
  state: SessionState;
  lifecycleError: string | null;
  model: string | null;
  /** Which account this session runs on and what it has spent, for the runtimes that report it. */
  account: NativeAccount | null;
  /** The account's plan windows, for the runtimes that report them. Null = never asked. */
  planLimits: PlanLimits | null;
  costUsd: number | null;
  contextLabel: string; // human CTX column
  context: ContextInfo; // structured, for --json
  uptimeText: string;
  uptimeSeconds: number | null;
  createdAt: string | null;
  lastMessage: TranscriptMessage | null;
  lastActivityMs: number | null; // transcript file mtime — "conversation moved" (any instance)
  // What a restart WOULD change for this session ("chat" / "mode" / "modules" / "config").
  // Empty = up to date, or launched before stamping existed (unknown is never shown as stale).
  stale: string[];
  /** When the turn that is running now began (ISO), or null. See `turnStartedAt` in the JSON
   *  contract for why it is an instant rather than an elapsed time. */
  turnStartedAt: string | null;
  /** What blocking menu this session is sitting at, if any — it cannot act until that is answered. */
  atPrompt: string | null;
  /** The session this one is waiting for, while it waits. */
  waitingFor: string | null;
}

/** Build one row. For a running session: scrape the pane; if it surfaces no context,
 *  fall back to the USED size from the transcript (size is known with or without a
 *  statusline). For a stopped session: everything blank. Mirrors bash `cmd_list`. */
async function buildRow(
  m: MachineConfig,
  s: Session,
  startedAt: number | undefined,
  nowSec: number,
  shouldCapture: boolean,
): Promise<ListRow> {
  const lastMessage = lastTranscriptMessage(s, m); // works running or stopped
  const activity = lastActivityMs(s, m);
  const native = hasNativeRuntime(s) ? managedRuntimeView(m, s) : null;
  if (startedAt === undefined && native?.read.status !== 'live') {
    scanCache.delete(s.name); // stopped → drop stale scan so a restart re-captures
    const block = readLifecycleBlockForSession(m, s);
    return {
      session: s,
      running: false,
      atPrompt: null, // a stopped session is not sitting at anything
      waitingFor: null, // nor waiting for anyone
      state: block ? 'blocked' : 'stopped',
      lifecycleError: block?.error ?? null,
      model: null,
      account: null,
      planLimits: null,
      costUsd: null,
      contextLabel: '-',
      context: {
        text: null,
        usedTokens: null,
        limitTokens: null,
        percent: null,
        rawLimitTokens: null,
        window: null,
      },
      uptimeText: '—',
      stale: [],
      turnStartedAt: null, // a stopped session is not in a turn
      uptimeSeconds: null,
      createdAt: null,
      lastMessage,
      lastActivityMs: activity,
    };
  }
  const provider = providerFor(s);
  // Capture the live pane only when this card is visible (or has no scan yet); otherwise reuse the
  // last scan — one fewer fork per off-screen running session, every poll.
  const cached = scanCache.get(s.name);
  let scan: PaneScan;
  if (native !== null) {
    scan = native.scan;
  } else if (shouldCapture || !cached) {
    scan = provider.scanPane(await capturePane(m, s.name, 30));
    scanCache.set(s.name, scan);
  } else {
    scan = cached;
  }
  // Structured status (Claude hooks + statusLine tee) is authoritative when present; the pane is the
  // cold-start fallback. State: a positive pane "working" (esc to interrupt) always wins — it covers a
  // session already mid-turn when ccmux (re)started, before a hook fired; else the hook lifecycle file;
  // else the pane. Context: prefer the statusLine-tee metrics (Claude's own %, no regex, no statusline-
  // format dependency), else the pane label, else the used-tokens count from the transcript.
  const lifecycle = readLifecycle(s.name);
  const turnStartedMs = lifecycle?.state === 'working' ? lifecycle.ts : null;
  const paneWorking = scan.state === 'working';
  const aliveMs = lastSignOfLife(
    activity,
    paneWorking ? nowSec * 1000 : paneWorkingSince(m, s.name),
    turnStartedMs,
  );
  const evidence = turnState({
    paneWorking,
    paneReady: provider.inspectChatPane === undefined ? true : scan.ready,
    atMenu: scan.atPrompt !== null,
    endedOnAssistantText: assistantEndedCurrentTurn(lastMessage, activity, turnStartedMs),
    msSinceActivity: aliveMs === null ? null : nowSec * 1000 - aliveMs,
  });
  const state: SessionState = native?.state ?? resolveLiveState(scan.state, lifecycle, evidence);
  let context = scan.context;
  let contextLabel = scan.contextLabel;
  const metrics = readMetrics(s.name);
  if (metrics !== null && metrics.pct !== null && metrics.contextSizeTokens !== null) {
    const used = Math.round((metrics.contextSizeTokens * metrics.pct) / 100);
    contextLabel = `${fmtTokens(used)}/${fmtTokens(metrics.contextSizeTokens)} ${metrics.pct}%`;
    context = {
      text: contextLabel,
      usedTokens: used,
      limitTokens: metrics.contextSizeTokens,
      percent: metrics.pct,
      // Scraped from a status line, which prints one number and never says which ceiling it is:
      // stated as unknown rather than guessed at.
      rawLimitTokens: null,
      window: null,
    };
  } else if (context.text === null) {
    const used = sessionUsedTokens(s, m);
    if (used !== null && used > 0) {
      contextLabel = fmtTokens(used);
      context = {
        text: contextLabel,
        usedTokens: used,
        limitTokens: null,
        percent: null,
        rawLimitTokens: null,
        window: null,
      };
    }
  }
  const uptimeSeconds = startedAt === undefined ? null : Math.floor(nowSec - startedAt);
  return {
    session: s,
    running: true,
    state,
    atPrompt: scan.atPrompt,
    waitingFor: readWaiting(s.name)?.target ?? null,
    lifecycleError:
      native?.state === 'blocked'
        ? `native status unavailable: ${native.read.reason ?? native.read.snapshot?.reason ?? 'unknown'}`
        : null,
    // Model from jsonl (source of truth), formatted for display — NOT scraped from the statusline,
    // so a new family (Fable/Mythos/…) is never dropped by a name whitelist.
    model: prettyModel(native?.read.snapshot?.nativeSelection?.model.model ?? sessionModel(s, m)),
    account: native?.read.snapshot?.account ?? null,
    planLimits: native?.read.snapshot?.planLimits ?? null,
    costUsd: native?.read.snapshot?.spend?.totalCostUsd ?? null,
    contextLabel,
    context,
    uptimeText: uptimeSeconds === null ? '—' : humanizeDuration(uptimeSeconds),
    // A stopped session is never "stale": it will pick everything up whenever it next starts.
    stale: staleReasons(readLaunchStamp(s.name), computeStamp(s, m, promptInvocation())),
    turnStartedAt: native === null ? turnStartedAt(state, lifecycle) : native.turnStartedAt,
    uptimeSeconds,
    createdAt: startedAt === undefined ? null : new Date(startedAt * 1000).toISOString(),
    lastMessage,
    lastActivityMs: activity,
  };
}

/**
 * When the turn that is running now began — reported only when BOTH signals agree there IS one.
 *
 * The resolved state says whether the session is working; the lifecycle file is the only thing that
 * knows WHEN, and it is only talking about the current turn while it too says `working`. Bounded
 * turn evidence can close a stale working stamp after an interrupt without treating one negative
 * spinner frame as an ending.
 *
 * Null is also the honest answer for a turn nothing recorded the start of: a provider without turn
 * hooks, or a turn already under way when ccmux started. `state` still says `working`, so "in a
 * turn, start unknown" stays distinguishable from "not in a turn".
 */
export function turnStartedAt(
  state: SessionState,
  lifecycle: LifecycleStatus | null,
): string | null {
  return state === 'working' && lifecycle?.state === 'working'
    ? new Date(lifecycle.ts).toISOString()
    : null;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/**
 * Archived (parked) sessions read as "archived" unless they are actually running — the run-state
 * (working/idle) is the more truthful signal then.
 *
 * Exported because the fleet map must reach the same verdict from a peer's JSON. It did not: it
 * printed the raw run-state, so a session someone had deliberately parked appeared as `stopped`,
 * which reads as a live session that is down and wants restarting. Fifty-five parked rows presented
 * that way is the difference between a map and a mess.
 */
export function rowStateLabel(state: string, running: boolean, archived: boolean): string {
  return archived && !running ? 'archived' : state;
}

function stateLabel(r: ListRow): string {
  if (r.session.archived && !r.running) return 'archived';
  // A session at a menu reads as `idle` to every other signal — the pane is still, no tool is
  // running, the agent is simply not there. It is the opposite of idle: it cannot proceed at all.
  if (r.atPrompt !== null) return 'prompt';
  return r.state;
}

function printTable(m: MachineConfig, rows: ListRow[]): void {
  console.log(
    `${pad('SESSION', 14)} ${pad('AGENT', 7)} ${pad('MODEL', 9)} ${pad('CTX', 16)} ${pad('STATE', 8)} ${pad('UPTIME', 7)} ${pad('RESTART', 9)} ${pad('RC', 14)} DIR`,
  );
  for (const r of rows) {
    console.log(
      `${pad(r.session.name, 14)} ${pad(r.session.agent, 7)} ${pad(r.model ?? '-', 9)} ${pad(r.contextLabel, 16)} ${pad(stateLabel(r), 8)} ${pad(r.uptimeText, 7)} ${pad(r.stale.length > 0 ? r.stale.join(',') : '-', 9)} ${pad(rcName(m, r.session.name), 14)} ${r.session.dir}`,
    );
    if (r.lifecycleError !== null) console.log(`  blocked: ${r.lifecycleError}`);
    // A declared env file that is not on disk. The session still starts — that was the deliberate
    // choice, since a supervisor whose sessions refuse to boot is worse than one variable short — so
    // this line is the only place a person finds out before wondering why a variable is empty.
    const env = envFileEntry(r.session);
    if (env !== null && !env.present) console.log(`  env file declared but missing: ${env.path}`);
  }
}

/** A session's declared env file, as the JSON contract reports it. Existence is checked HERE rather
 *  than trusted from the registry: the file is somebody's working file and can appear or vanish
 *  between launches, and "declared but not there" is the state worth seeing. */
function envFileEntry(s: Session): { path: string; present: boolean } | null {
  const path = envFilePath(s);
  return path === null ? null : { path, present: existsSync(path) };
}

function toListItem(m: MachineConfig, r: ListRow): ListItem {
  return {
    name: r.session.name,
    agent: r.session.agent,
    dir: r.session.dir,
    uuid: r.session.uuid,
    rc: rcName(m, r.session.name),
    running: r.running,
    archived: r.session.archived,
    state: r.state,
    atPrompt: r.atPrompt,
    waitingFor: r.waitingFor,
    lifecycleError: r.lifecycleError,
    model: r.model,
    account: r.account,
    planLimits: r.planLimits,
    costUsd: r.costUsd,
    context: r.context,
    uptime: { text: r.running ? r.uptimeText : null, seconds: r.uptimeSeconds },
    stale: r.stale,
    role: r.session.role ?? null,
    turnStartedAt: r.turnStartedAt,
    envFile: envFileEntry(r.session),
    createdAt: r.createdAt,
    lastMessage: r.lastMessage,
  };
}

function printJson(m: MachineConfig, rows: ListRow[]): void {
  const out: ListJson = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    rcPrefix: m.rcPrefix,
    stateDir: m.stateDir,
    release: releaseStanding(m, VERSION),
    sessions: rows.map((r) => toListItem(m, r)),
  };
  console.log(JSON.stringify(out));
}

/** The single data source for both the CLI table/JSON and the live TUI. `liveNames` (TUI only) =
 *  the session names whose pane should be freshly captured this tick (visible + selected); others
 *  reuse their cached scan. Omit it (CLI `list`) to capture every running session, as before. */
export async function collectRows(
  m: MachineConfig,
  opts?: { liveNames?: Set<string> },
): Promise<ListRow[]> {
  const created = await listSessionsCreated(m);
  const nowSec = Date.now() / 1000;
  const sessions = loadSessions(m);
  const liveNames = opts?.liveNames;
  return Promise.all(
    sessions.map((s) =>
      buildRow(m, s, created.get(s.name), nowSec, liveNames === undefined || liveNames.has(s.name)),
    ),
  );
}

/** The three fields the account grouping reads, so `list` and `fleet` answer from one implementation. */
const fleetRowSlice = (r: ListRow) => ({
  name: r.session.name,
  account: r.account,
  costUsd: r.costUsd,
  planLimits: r.planLimits,
});

export async function cmdList(args: string[] = []): Promise<number> {
  const m = loadMachineConfig();
  const rows = await collectRows(m);
  // `--json` is a machine's answer and stays complete: a consumer filters for itself, and a reader
  // that asked for everything must not be given a view. Only the human table folds.
  if (args.includes('--json')) {
    printJson(m, rows);
    return 0;
  }
  const all = args.includes('--all');
  const shown = all ? rows : rows.filter((r) => !(r.session.archived && !r.running));
  printTable(m, shown);
  const parked = rows.length - shown.length;
  if (parked > 0) console.log(`… ${parked} archived (ccmux list --all)`);
  // Printed after the table rather than as a column: the plan window belongs to the account, so it
  // is one fact about several rows, and a per-row column would repeat one budget as many.
  for (const line of accountLines(
    [{ machine: m.rcPrefix, sessions: shown.map(fleetRowSlice) } as never],
    Date.now(),
  ))
    console.log(line);
  return 0;
}

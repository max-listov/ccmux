import { existsSync } from 'node:fs';
import type { PaneScan } from '../agent/index.ts';
import {
  lastActivityMs,
  lastTranscriptMessage,
  providerFor,
  sessionModel,
  sessionUsedTokens,
} from '../agent/index.ts';
import { envFilePath } from '../agent/launch/launchInputs.ts';
import { launchStaleReasons } from '../agent/launch/launchStamp.ts';
import { localRows } from '../chat/fleetLog.ts';
import { loadLedger } from '../chat/ledger.ts';
import { letterCounts, NO_LETTERS, type SessionLetters } from '../chat/letters.ts';
import { assistantEndedCurrentTurn, turnState } from '../chat/turnState.ts';
import { rcName } from '../config/machine.ts';
import { lastSignOfLife } from '../events/observe.ts';
import { paneWorkingSince } from '../events/paneActivity.ts';
import { loadOutboxAcked } from '../fleet/flush.ts';
import { loadOutbox } from '../fleet/outbox.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import type { PlanLimits } from '../runtime/planLimits.ts';
import type { NativeAccount } from '../runtime/projectionSchema.ts';
import { managedRuntimeView } from '../runtime/view.ts';
import { readLifecycleBlockForSession } from '../session/lifecycleBlocks.ts';
import { loadSessions } from '../session/registry.ts';
import {
  type LifecycleStatus,
  readLaunchStamp,
  readLifecycle,
  readMetrics,
  readWaiting,
  resolveLiveState,
} from '../session/status.ts';
import { listAgentLiveness } from '../tmux/agentPane.ts';
import { capturePane, listSessionsCreated } from '../tmux/tmux.ts';
import { fmtTokens } from '../tui/format.ts';
import type {
  ContextInfo,
  ListItem,
  MachineConfig,
  Session,
  SessionState,
  TranscriptMessage,
} from '../types.ts';
import { humanizeDuration } from '../util/duration.ts';
import { promptInvocation } from '../util/env.ts';
import { prettyModel } from './modelName.ts';

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
  /** The model id exactly as the runtime reported it. `model` is its display label, and a label
   *  cannot answer who MADE the model: `prettyModel` strips the `claude-` prefix, so a family
   *  nobody has heard of yet ("Mythos 6") would lose its vendor. The raw id keeps it. */
  modelId: string | null;
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
  tmux: ListItem['tmux'];
  lastMessage: TranscriptMessage | null;
  /** How many letters this session has exchanged, over the machine's whole record. */
  letters: SessionLetters;
  lastActivityMs: number | null; // transcript file mtime — "conversation moved" (any instance)
  // What a restart WOULD change for this session ("chat" / "mode" / "modules" / "config").
  // Empty = up to date, or launched before stamping existed (unknown is never shown as stale).
  stale: string[];
  /** Why `stale` could not be computed for this reader (its recipe does not build), or null. */
  staleUnknown: string | null;
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
  letters: ReadonlyMap<string, SessionLetters>,
  agentPane: string | null,
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
      modelId: null,
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
      staleUnknown: null,
      turnStartedAt: null, // a stopped session is not in a turn
      uptimeSeconds: null,
      createdAt: null,
      tmux: null,
      lastMessage,
      letters: letters.get(s.name) ?? NO_LETTERS,
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
  const restart = launchStaleReasons(readLaunchStamp(s.name), s, m, promptInvocation());
  const modelId = native?.read.snapshot?.nativeSelection?.model.model ?? sessionModel(s, m);
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
    model: prettyModel(modelId),
    modelId,
    // The live answer first, then the one kept from before it stopped: a blocked session still ran
    // on an account, and dropping the row made a consumer's plan bar read as "no plan".
    account: native?.read.snapshot?.account ?? native?.read.retained?.account ?? null,
    planLimits: native?.read.snapshot?.planLimits ?? null,
    costUsd: native?.read.snapshot?.spend?.totalCostUsd ?? null,
    contextLabel,
    context,
    uptimeText: uptimeSeconds === null ? '—' : humanizeDuration(uptimeSeconds),
    // A stopped session is never "stale": it will pick everything up whenever it next starts.
    stale: restart.reasons,
    staleUnknown: restart.unknown,
    turnStartedAt: native === null ? turnStartedAt(state, lifecycle) : native.turnStartedAt,
    uptimeSeconds,
    createdAt: startedAt === undefined ? null : new Date(startedAt * 1000).toISOString(),
    // A native runtime with no tmux session has no tmux target to declare.
    tmux:
      startedAt === undefined ? null : { socket: m.tmuxSocket ?? null, session: s.name, agentPane },
    lastMessage,
    letters: letters.get(s.name) ?? NO_LETTERS,
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

/**
 * What the state column shows, for `list` and `fleet` alike.
 *
 * A session at a menu reads as `idle` to every other signal — the pane is still, no tool is running,
 * the agent is simply not there. It is the opposite of idle: it cannot proceed at all, so the menu is
 * what the column says. The two commands used to answer this differently (`prompt` in one, the menu
 * in the other) about the same session.
 */
export function stateCell(state: string, atPrompt: string | null): string {
  return atPrompt ?? state;
}

/** A session's declared env file, as the JSON contract reports it. Existence is checked HERE rather
 *  than trusted from the registry: the file is somebody's working file and can appear or vanish
 *  between launches, and "declared but not there" is the state worth seeing. */
export function envFileEntry(s: Session): { path: string; present: boolean } | null {
  const path = envFilePath(s);
  return path === null ? null : { path, present: existsSync(path) };
}

/**
 * The row every answer about a session is made of.
 *
 * Exported because the fleet slice reports the SAME sessions for this machine, and it used to build
 * its own copy with a hand-picked subset of the fields. Every field added since had to be added
 * twice, and until the second edit a peer's sessions read as "nothing to show" rather than "not
 * reported" — `waitingFor`, the context window, the last message and the plan limits each shipped
 * broken that way, and three of the four were found by a consumer rather than here.
 */
export function toListItem(m: MachineConfig, r: ListRow): ListItem {
  return {
    letters: r.letters,
    tmux: r.tmux,
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
    modelId: r.modelId,
    account: r.account,
    planLimits: r.planLimits,
    costUsd: r.costUsd,
    context: r.context,
    uptime: { text: r.running ? r.uptimeText : null, seconds: r.uptimeSeconds },
    stale: r.stale,
    staleUnknown: r.staleUnknown,
    role: r.session.role ?? null,
    turnStartedAt: r.turnStartedAt,
    envFile: envFileEntry(r.session),
    createdAt: r.createdAt,
    lastMessage: r.lastMessage,
  };
}

/** The single data source for both the CLI table/JSON and the live TUI. `liveNames` (TUI only) =
 *  the session names whose pane should be freshly captured this tick (visible + selected); others
 *  reuse their cached scan. Omit it (CLI `list`) to capture every running session, as before. */
export async function collectRows(
  m: MachineConfig,
  opts?: { liveNames?: Set<string>; only?: string },
): Promise<ListRow[]> {
  const [created, { agentPanes }] = await Promise.all([
    listSessionsCreated(m),
    listAgentLiveness(m),
  ]);
  const nowSec = Date.now() / 1000;
  // One session's row is built by the same code as the whole list: a second way to decide a
  // session's state would disagree with the first the day either changed.
  const sessions = loadSessions(m).filter((s) => opts?.only === undefined || s.name === opts.only);
  const liveNames = opts?.liveNames;
  // One pass for the whole machine, from the same two sources `chat log` prints: the ledger for what
  // arrived and the outbox for what was sent. Per row it would be one pass per session.
  const letters = letterCounts(
    localRows(m.rcPrefix, loadLedger(m), loadOutbox(m), loadOutboxAcked(m)),
    m.rcPrefix,
  );
  return Promise.all(
    sessions.map((s) =>
      buildRow(
        m,
        s,
        created.get(s.name),
        nowSec,
        liveNames === undefined || liveNames.has(s.name),
        letters,
        agentPanes.get(s.name) ?? null,
      ),
    ),
  );
}

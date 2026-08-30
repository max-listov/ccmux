import { providerFor, lastActivityMs, lastTranscriptMessage } from "../agent/index.ts";
import { closeLifecycleTurn, readLifecycle } from "../agent/sessionStatus.ts";
import { readLifecycleBlockForSession } from "../config/lifecycleBlocks.ts";
import { eventsEnabledFor } from "../config/events.ts";
import { loadSessions } from "../config/sessions.ts";
import { observedPane, observedSessionInventory } from "../monitoring/tmux.ts";
import { assistantEndedCurrentTurn, turnState } from "../chat/turnState.ts";
import type { MachineConfig, Session } from "../types.ts";
import { appendEvent, type EmitInput } from "./feed.ts";
import { readPaneActivity, writePaneActivity } from "./paneActivity.ts";
import { hasNativeRuntime } from "../runtime/capabilities.ts";
import { managedRuntimeView } from "../runtime/view.ts";

/**
 * The half of the feed the turn hook cannot write.
 *
 * A hook only fires for things the agent chooses to do. Three of the states that matter most are
 * things that HAPPEN TO it, and the agent is by definition not running when they do:
 *
 *  - **waiting at a menu** — the agent is stopped at a prompt it cannot answer itself. Every other
 *    signal reads this as idle: the pane is still, no tool is running. It is the opposite of idle.
 *  - **an interrupted turn** — `Stop` fires only when a turn ends VOLUNTARILY, so a turn somebody
 *    escaped out of has a `turn-start` and would never get an end. A reader tracking state would
 *    show that session as working forever.
 *  - **a session that died or was stopped** — nothing inside it survives to say so.
 *
 * So this observes, and observation costs a pane capture per running session. That cost is not new:
 * it is what an outside surface was already paying by polling `list --json` on a timer. Paying it
 * once in the supervisor and publishing the result is strictly cheaper than paying it once per
 * consumer, and it is the only version of the cost that can also see the moment.
 */

/** What the supervisor can see about a session from outside it. */
export interface Observed {
  running: boolean;
  /** Title of the blocking menu, or null when it is not at one. */
  waitingAt: string | null;
  /** Terminal lifecycle failure, or null. */
  blocked: string | null;
  /** Start instant of the turn the lifecycle file says is running, or null when it says otherwise. */
  turnStartedMs: number | null;
  /**
   * That turn is over anyway, and this is the instant it actually stopped — the last time the
   * transcript moved, not "now".
   *
   * The difference is the whole value of the number. A turn is only PROVEN dead after a stretch of
   * silence, so the moment we can say so is always later than the moment it happened — by the length
   * of the silence, plus however long until a pass looked. Measuring to `now` therefore inflates
   * every such turn by at least a minute, and one that nobody looked at for an hour by an hour. The
   * transcript's last write is when the work actually stopped.
   *
   * Null while the turn is (or may still be) live — and null when the lifecycle file is not claiming
   * a turn at all, so this and `turnStartedMs` are set together or not at all.
   */
  turnOverMs: number | null;
  /** That turn did not end in the agent's own words — it was cut short. */
  turnInterrupted: boolean;
  /**
   * When the pane was last seen doing work.
   *
   * A spinner IS activity, exactly as a transcript write is, and counting only the second one is how
   * a live turn gets declared dead. A session in a five-minute tool call writes nothing for five
   * minutes: the transcript is legitimately frozen, and the only thing still saying "alive" is the
   * pane. One pass that samples the pane in the instant between a tool finishing and its result
   * being written sees no spinner and a transcript quiet for minutes — indistinguishable, on that
   * evidence alone, from a turn nobody is coming back to. Measured: a live turn closed and announced
   * as interrupted 29 seconds after its own pane had been working.
   *
   * So the proof window is measured from the LATER of the two. Nothing is loosened for a turn that
   * really stopped — its pane stops with it.
   */
  paneWorkingMs: number | null;
  /**
   * Which turn we have already closed, by its start instant.
   *
   * NOT a boolean, and that distinction is the whole reason it is written down. The evidence a turn
   * is over is derived from how long the transcript has been quiet, so it returns to false the
   * moment the file stirs and rises again after the next silence — it flickers within a single turn.
   * Deduping on "was it true last pass" therefore reported the SAME abandoned turn over and over:
   * measured on a live machine, one turn produced three events in six minutes with a growing
   * duration, which for a consumer that speaks and blinks is three announcements of one thing.
   *
   * Identity of the turn does not flicker. Remember which turn was closed, and stay quiet until a
   * different one starts.
   */
  turnClosedFor: number | null;
}

export const UNSEEN: Observed = { running: false, waitingAt: null, blocked: null, turnStartedMs: null, turnOverMs: null, turnInterrupted: false, paneWorkingMs: null, turnClosedFor: null };

/**
 * Transitions between two observations. Pure, and the reason the daemon side stays testable without
 * tmux: everything hard about this module is the DIFF, not the capture.
 *
 * Deliberately not emitted here: `session-start`. The hook says it better — it fires when the agent
 * has actually booted its conversation, whereas the supervisor only sees a pane appear, which is a
 * few seconds earlier and sometimes a false start (a session that immediately dies). Two writers
 * announcing the same thing differently is worse than one writer announcing it late.
 */
export function transitions(prev: Observed, next: Observed): EmitInput[] {
  const out: EmitInput[] = [];
  if (prev.running && !next.running) {
    out.push({ event: "session-stop" });
    return out; // a stopped session has no menu and no turn; anything else would be about a ghost
  }
  if (!next.running) return out;
  if (next.blocked !== null && prev.blocked !== next.blocked) out.push({ event: "session-blocked", detail: next.blocked });
  if (next.waitingAt !== null && prev.waitingAt !== next.waitingAt) out.push({ event: "waiting", detail: next.waitingAt });
  if (prev.waitingAt !== null && next.waitingAt === null) out.push({ event: "resumed" });
  // A turn the hook never ended. Once per TURN, not once per rise of a flickering signal — see
  // `turnClosedFor`.
  //
  // `prev.running` is the gate that keeps this an OBSERVATION rather than an invention. A turn that
  // was already over the first time we looked did not end while we were watching: its ending is
  // state we inherited, not a moment we saw, and announcing it would date a two-day-old event to the
  // instant a daemon happened to start. The stamp still gets closed either way — see `observeOnce`.
  if (next.turnOverMs !== null && next.turnStartedMs !== null && prev.running && prev.turnClosedFor !== next.turnStartedMs) {
    // An ordinary end, flagged only when it was cut short — a consumer that just wants "it finished"
    // should not have to know how, and one that cares can see it. A hook that never fired is not
    // interruption: the turn ended in the agent's own words and only the announcement went missing.
    out.push({
      event: "turn-end",
      durationMs: Math.max(0, next.turnOverMs - next.turnStartedMs),
      ...(next.turnInterrupted ? { interrupted: true } : {}),
    });
  }
  return out;
}

/**
 * The most recent evidence this session is alive, from EITHER source.
 *
 * A transcript write and a turning spinner both mean the session is doing something, and taking only
 * the first declares a long tool call dead: a session four minutes into a build writes nothing, and
 * the pane is the only thing still saying otherwise.
 */
export function lastSignOfLife(
  transcriptMs: number | null,
  paneWorkingMs: number | null,
  turnStartedMs: number | null = null,
): number | null {
  if (turnStartedMs === null) {
    if (transcriptMs === null) return paneWorkingMs;
    if (paneWorkingMs === null) return transcriptMs;
    return Math.max(transcriptMs, paneWorkingMs);
  }
  // Evidence from an older turn cannot keep this one alive or claim that it ended in assistant
  // text. The lifecycle start itself is the first current-turn sign of life.
  return Math.max(
    turnStartedMs,
    transcriptMs !== null && transcriptMs >= turnStartedMs ? transcriptMs : turnStartedMs,
    paneWorkingMs !== null && paneWorkingMs >= turnStartedMs ? paneWorkingMs : turnStartedMs,
  );
}

/**
 * Does this pass close the stamp?
 *
 * `prev.running` is the baseline the pass is a diff against, and a first look has none: it cannot
 * tell a turn that died an hour ago from one whose pane it sampled in the instant between a tool
 * finishing and its result being written. So the first pass establishes what "before" was and acts
 * on nothing; the second, two seconds later, is where an inherited orphan gets closed.
 */
export function shouldCloseTurn(prev: Observed, next: Observed): boolean {
  return prev.running && next.turnOverMs !== null && prev.turnClosedFor !== next.turnStartedMs;
}

/**
 * One session, as seen from outside. Pane text is passed in so the decision stays pure-ish and the
 * capture happens once per session per pass.
 *
 * `lastPaneWorkingMs` is the caller's memory of when this pane was last seen working — the only
 * thing here that a single glance cannot supply, and the difference between "quiet because the turn
 * is dead" and "quiet because a tool has been running for four minutes".
 */
export function observe(
  m: MachineConfig,
  s: Session,
  running: boolean,
  pane: string | null,
  nowMs: number,
  lastPaneWorkingMs: number | null = null,
): Observed {
  if (!running) return { ...UNSEEN, running: false };
  if (hasNativeRuntime(s)) {
    const native = managedRuntimeView(m, s, nowMs);
    return { ...UNSEEN, running: true, waitingAt: native.atPrompt,
      blocked: native.read.status === "live" ? null : `native status unavailable: ${native.read.reason}`,
      turnStartedMs: native.turnStartedAt === null ? null : Date.parse(native.turnStartedAt) };
  }
  const provider = providerFor(s);
  const block = readLifecycleBlockForSession(m, s);
  const lifecycle = readLifecycle(s.name);
  const scan = pane === null ? null : provider.scanPane(pane);
  const lm = lastTranscriptMessage(s, m);
  const activity = lastActivityMs(s, m);
  const paneWorking = scan?.state === "working";
  const paneWorkingMs = paneWorking ? nowMs : lastPaneWorkingMs;
  const claimed = lifecycle?.state === "working" ? lifecycle.ts : null;
  const aliveMs = lastSignOfLife(activity, paneWorkingMs, claimed);
  const state =
    pane === null
      ? null
      : turnState({
          paneWorking,
          paneReady: provider.inspectChatPane === undefined ? true : scan?.ready === true,
          atMenu: scan?.atPrompt !== null,
          endedOnAssistantText: assistantEndedCurrentTurn(lm, activity, claimed),
          msSinceActivity: aliveMs === null ? null : nowMs - aliveMs,
        });
  // The lifecycle file claims a turn is running, and the turn state proves it is not. Only a SETTLED
  // turn counts: `settling`/`quiet-unproven` are not yet proof, and acting on them would close a
  // turn during a pause between tool calls. A pane we could not capture yields no turn state at all,
  // which is correctly no proof of anything.
  const over = claimed !== null && state?.settled === true;
  return {
    running: true,
    // Carried forward by the caller after each pass; an observation cannot know it on its own.
    turnClosedFor: null,
    paneWorkingMs,
    waitingAt: scan?.atPrompt ?? null,
    blocked: block?.error ?? null,
    turnStartedMs: claimed,
    // When the work actually stopped: the transcript's last write. Clamped into [start, now] so a
    // frozen or forked transcript can never produce a negative duration or one that runs into the
    // future; a session that never spoke has no transcript instant to use, so the pass's own clock
    // stands in.
    turnOverMs: over ? Math.round(Math.min(nowMs, Math.max(claimed, activity ?? nowMs))) : null,
    turnInterrupted: over && state?.why === "idle-after-interrupt",
  };
}

/**
 * One observation pass over the machine's sessions: close what the hook abandoned, publish what
 * changed.
 *
 * `previous` is the caller's memory across passes — held by the daemon, so a restart of the daemon
 * simply re-observes rather than replaying history. Sessions that vanish from the registry are
 * dropped from it, so a removed session cannot leave a permanent entry behind.
 *
 * The events switch decides what is PUBLISHED, not what is looked at. Closing an abandoned turn is
 * not publishing — it is repairing this machine's own record of what its sessions are doing, which
 * `list`, the TUI and every snapshot read whether or not anybody subscribed to a feed. A session
 * with events switched off would otherwise keep a `working` stamp from a turn that ended days ago,
 * and hand that stale instant to its next turn as a start time.
 */
export async function observeOnce(m: MachineConfig, previous: Map<string, Observed>, nowMs = Date.now(),
  sample?: (m: MachineConfig, s: Session, startedAt: number | undefined, pane: string | null, seen: Observed) => void,
): Promise<number> {
  const sessions = loadSessions(m);
  const running = await observedSessionInventory(m);
  // Seeded from disk so a supervisor that just restarted is not blind about panes it watched a
  // moment ago — its own last write is the memory its predecessor kept.
  const onDisk = readPaneActivity(m);
  const paneWorking = new Map<string, number>();
  const seen = new Set<string>();
  let emitted = 0;
  for (const s of sessions) {
    seen.add(s.name);
    const isRunning = running.has(s.name);
    // Capture only what is running: a stopped session has no pane, and asking for one is a fork per
    // session per pass spent to be told so.
    const pane = isRunning && !hasNativeRuntime(s) ? await observedPane(m, s.name).catch(() => null) : null;
    const prev = previous.get(s.name) ?? UNSEEN;
    const next = observe(m, s, isRunning, pane, nowMs, prev.paneWorkingMs ?? onDisk[s.name] ?? null);
    sample?.(m, s, running.get(s.name), pane, next);
    if (s.archived) continue;
    if (next.paneWorkingMs !== null) paneWorking.set(s.name, next.paneWorkingMs);
    // The stamp is repaired whether or not the ending is announced — `transitions` stays silent
    // about an ending it never witnessed, and silence about an event is not a reason to leave a
    // false state behind.
    const closing = shouldCloseTurn(prev, next);
    if (closing && next.turnOverMs !== null) await closeTurn(s.name, next.turnOverMs);
    const events = eventsEnabledFor(s, m) ? transitions(prev, next) : [];
    for (const input of events) {
      appendEvent(m, s, input);
      emitted += 1;
    }
    // Carry the memory this pass produced. Kept out of `observe` because it is memory, not
    // observation — and out of `transitions` because that stays pure.
    previous.set(s.name, {
      ...next,
      turnClosedFor: closing ? next.turnStartedMs : prev.turnClosedFor,
    });
  }
  for (const name of [...previous.keys()]) if (!seen.has(name)) previous.delete(name);
  // Published for the readers that cannot keep this memory themselves — `ccmux wait`, a fresh
  // process on every call, and deferred chat delivery. See `paneActivity.ts`.
  await writePaneActivity(m, paneWorking);
  return emitted;
}

/** Best-effort, like every other status write: a stamp we could not close must not abort the pass
 *  and cost the remaining sessions theirs. Re-read immediately before the write, so a turn that
 *  started in the milliseconds since the observation is not closed on the strength of stale
 *  evidence. */
async function closeTurn(name: string, endedMs: number): Promise<void> {
  try {
    const current = readLifecycle(name);
    if (current === null || current.state !== "working") return;
    await closeLifecycleTurn(name, current, endedMs);
  } catch {
    // the next pass tries again
  }
}

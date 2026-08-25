import { providerFor, lastActivityMs, lastTranscriptMessage } from "../agent/index.ts";
import { readLifecycle } from "../agent/sessionStatus.ts";
import { readLifecycleBlockForSession } from "../config/lifecycleBlocks.ts";
import { eventsEnabledFor } from "../config/events.ts";
import { loadSessions } from "../config/sessions.ts";
import { capturePane, listSessionNames } from "../tmux/tmux.ts";
import { turnState } from "../chat/turnState.ts";
import type { MachineConfig, Session } from "../types.ts";
import { appendEvent, type EmitInput } from "./feed.ts";

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
  /** The lifecycle file says a turn is running, and the turn is provably over anyway. */
  turnInterrupted: boolean;
  /** Start instant of the running turn, when one is known — the duration for an interrupted end. */
  turnStartedMs: number | null;
  /**
   * Which turn we have already reported as interrupted, by its start instant.
   *
   * NOT a boolean, and that distinction is the whole fix. `turnInterrupted` is derived from how long
   * the transcript has been quiet, so it returns to false the moment the file stirs and rises again
   * after the next silence — it flickers within a single turn. Deduping on "was it true last pass"
   * therefore reported the SAME abandoned turn over and over: measured on a live machine, one turn
   * produced three events in six minutes with a growing duration, which for a consumer that speaks
   * and blinks is three announcements of one thing.
   *
   * Identity of the turn does not flicker. Remember which turn was announced, and stay quiet until a
   * different one starts.
   */
  interruptReportedFor: number | null;
}

export const UNSEEN: Observed = { running: false, waitingAt: null, blocked: null, turnInterrupted: false, turnStartedMs: null, interruptReportedFor: null };

/**
 * Transitions between two observations. Pure, and the reason the daemon side stays testable without
 * tmux: everything hard about this module is the DIFF, not the capture.
 *
 * Deliberately not emitted here: `session-start`. The hook says it better — it fires when the agent
 * has actually booted its conversation, whereas the supervisor only sees a pane appear, which is a
 * few seconds earlier and sometimes a false start (a session that immediately dies). Two writers
 * announcing the same thing differently is worse than one writer announcing it late.
 */
export function transitions(prev: Observed, next: Observed, nowMs: number): EmitInput[] {
  const out: EmitInput[] = [];
  if (prev.running && !next.running) {
    out.push({ event: "session-stop" });
    return out; // a stopped session has no menu and no turn; anything else would be about a ghost
  }
  if (!next.running) return out;
  if (next.blocked !== null && prev.blocked !== next.blocked) out.push({ event: "session-blocked", detail: next.blocked });
  if (next.waitingAt !== null && prev.waitingAt !== next.waitingAt) out.push({ event: "waiting", detail: next.waitingAt });
  if (prev.waitingAt !== null && next.waitingAt === null) out.push({ event: "resumed" });
  // Once per TURN, not once per rise of a flickering signal — see `interruptReportedFor`.
  if (next.turnInterrupted && prev.interruptReportedFor !== next.turnStartedMs) {
    // Reported as an ordinary end, flagged — a consumer that only wants "it finished" should not
    // have to know about interruption, and one that cares can see it.
    const durationMs = next.turnStartedMs === null ? undefined : Math.max(0, nowMs - next.turnStartedMs);
    out.push({ event: "turn-end", interrupted: true, ...(durationMs === undefined ? {} : { durationMs }) });
  }
  return out;
}

/** One session, as seen from outside. Pane text is passed in so the decision stays pure-ish and the
 *  capture happens once per session per pass. */
export function observe(m: MachineConfig, s: Session, running: boolean, pane: string | null, nowMs: number): Observed {
  if (!running) return { ...UNSEEN, running: false };
  const provider = providerFor(s);
  const block = readLifecycleBlockForSession(m, s);
  const lifecycle = readLifecycle(s.name);
  const scan = pane === null ? null : provider.scanPane(pane);
  const lm = lastTranscriptMessage(s, m);
  const activity = lastActivityMs(s, m);
  const state =
    pane === null
      ? null
      : turnState({
          paneWorking: scan?.state === "working",
          paneReady: provider.chatDeliverable === undefined ? true : scan?.ready === true,
          atMenu: provider.chatDeliverable?.(pane) === false,
          endedOnAssistantText: lm !== null && lm.role === "assistant" && lm.kind === "message",
          msSinceActivity: activity === null ? null : nowMs - activity,
        });
  return {
    running: true,
    // Carried forward by the caller after each pass; an observation cannot know it on its own.
    interruptReportedFor: null,
    waitingAt: scan?.atPrompt ?? null,
    blocked: block?.error ?? null,
    // Only an OBSERVED interruption counts: the lifecycle file claims a turn is running while the
    // turn state proves it is over. `settling`/`quiet-unproven` are not yet proof and must not be
    // reported, or every pause between tool calls would announce a dead turn.
    turnInterrupted: lifecycle?.state === "working" && state?.why === "idle-after-interrupt",
    turnStartedMs: lifecycle?.state === "working" ? lifecycle.ts : null,
  };
}

/**
 * One observation pass over the machine's sessions, emitting only what changed.
 *
 * `previous` is the caller's memory across passes — held by the daemon, so a restart of the daemon
 * simply re-observes rather than replaying history. Sessions that vanish from the registry are
 * dropped from it, so a removed session cannot leave a permanent entry behind.
 */
export async function observeOnce(m: MachineConfig, previous: Map<string, Observed>, nowMs = Date.now()): Promise<number> {
  const sessions = loadSessions(m).filter((s) => !s.archived);
  const running = await listSessionNames(m);
  const seen = new Set<string>();
  let emitted = 0;
  for (const s of sessions) {
    seen.add(s.name);
    if (!eventsEnabledFor(s, m)) continue;
    const isRunning = running.has(s.name);
    // Capture only what is running: a stopped session has no pane, and asking for one is a fork per
    // session per pass spent to be told so.
    const pane = isRunning ? await capturePane(m, s.name, 40).catch(() => null) : null;
    const next = observe(m, s, isRunning, pane, nowMs);
    const prev = previous.get(s.name) ?? UNSEEN;
    const events = transitions(prev, next, nowMs);
    for (const input of events) {
      appendEvent(m, s, input);
      emitted += 1;
    }
    // Carry the "already announced" mark across passes: set when this pass announced an interrupted
    // turn, inherited otherwise. Kept out of `observe` because it is memory, not observation — and
    // out of `transitions` because that stays pure.
    const announcedInterrupt = events.some((e) => e.event === "turn-end" && e.interrupted === true);
    previous.set(s.name, { ...next, interruptReportedFor: announcedInterrupt ? next.turnStartedMs : prev.interruptReportedFor });
  }
  for (const name of [...previous.keys()]) if (!seen.has(name)) previous.delete(name);
  return emitted;
}

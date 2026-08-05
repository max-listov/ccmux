/**
 * Is this session between turns right now?
 *
 * The question everything downstream needs, asked once, as a pure function over facts the caller
 * has already gathered. It exists as its own unit because the previous version lived inside a
 * function that did three file reads — untestable, and that is precisely why it shipped with a hole.
 *
 * The hole: it asked "how did the turn END" (last transcript entry is assistant text) and never
 * "is a turn RUNNING". Those coincide until a turn is killed — a restart or an interrupt mid-work
 * leaves the conversation ending on a tool result that no assistant line will ever follow. The
 * session then looks perfectly idle to a human, accepts typing, answers — while deferred mail waits
 * for an event that cannot occur, and `ccmux wait` runs to its timeout reporting "still working".
 *
 * The fix does NOT drop that signal, and does not bolt an alternative beside it. It DEMOTES it from
 * a veto to a measure of confidence: a turn that ended in words is strong evidence, so a short
 * settle window suffices; anything else is weak evidence, so we wait long enough that a live turn
 * would have moved the transcript. One expression, two thresholds, no alternatives to keep in sync.
 */

/** Quiet needed when the transcript ends on assistant TEXT — a turn is written as separate
 *  thinking/text/tool_use records, so "assistant text last" also occurs mid-turn, in a gap measured
 *  in a second or two. This only has to outlast that gap. */
export const SETTLE_MS = 6_000;

/**
 * Quiet needed when the last record is anything else — the turn may have been killed, or may simply
 * be between tool calls. Chosen from the code, not from taste:
 *  - the delivery loop runs every 3s, so a minute is ~20 independent pane samples that must ALL read
 *    not-working before a live turn could be misjudged;
 *  - it must stay above the 30s heal interval, because for up to one heal cycle after a conversation
 *    forks the registry still points at the frozen old file and "quiet" would be an artifact;
 *  - it stays well under `wait`'s 300s default, so `wait` answers instead of timing out.
 */
export const INTERRUPTED_MS = 60_000;

export type TurnWhy =
  | "working" // the agent is mid-work right now
  | "not-drawn" // the UI has not painted yet (starting/resuming) — typing here is swallowed
  | "at-menu" // sitting on a selection prompt — typing here picks an option it never chose
  | "settling" // ended on text, but too recently to be sure the turn is over
  | "quiet-unproven" // last record is not text and the silence is not yet long enough to mean anything
  | "turn-ended" // finished on its own words
  | "idle-after-interrupt" // quiet far too long to be mid-turn — the turn was killed
  | "never-spoke"; // no transcript at all — this session has not taken a turn yet

export interface TurnFacts {
  paneWorking: boolean;
  paneReady: boolean;
  atMenu: boolean;
  /** true when the transcript's last record is an assistant MESSAGE (not a tool call / thinking). */
  endedOnAssistantText: boolean;
  /** ms since the transcript last moved; null = no transcript at all (a session that never had a
   *  turn — infinitely quiet, and previously a permanent hold of its own). */
  msSinceActivity: number | null;
}

export interface TurnState {
  settled: boolean;
  why: TurnWhy;
}

export function turnState(f: TurnFacts): TurnState {
  // Hard preconditions, in order of how badly getting them wrong hurts. `not-drawn` is not caution
  // for its own sake: delivery ACKS what it types, so a keystroke swallowed by a half-painted UI is
  // a letter marked delivered and never seen again — the worst outcome available here, and the one
  // a bare quiet-threshold walks straight into after a restart.
  if (f.paneWorking) return { settled: false, why: "working" };
  if (!f.paneReady) return { settled: false, why: "not-drawn" };
  if (f.atMenu) return { settled: false, why: "at-menu" };

  // "Never had a turn" is its own answer, not an interrupted one. Both are settled — the session is
  // genuinely between turns — but only one of them may be described as a turn that was cut short,
  // and `wait` needs to tell a caller which of the two it is looking at.
  if (f.msSinceActivity === null) return { settled: true, why: "never-spoke" };
  if (f.endedOnAssistantText) {
    return f.msSinceActivity >= SETTLE_MS ? { settled: true, why: "turn-ended" } : { settled: false, why: "settling" };
  }
  // Distinct from `settling`: nothing was said here, so saying "it just spoke" would be false about
  // exactly the population this whole change is for.
  return f.msSinceActivity >= INTERRUPTED_MS ? { settled: true, why: "idle-after-interrupt" } : { settled: false, why: "quiet-unproven" };
}

/** One sentence per cause, so the daemon's hold note, `inbox` and `wait` cannot drift into telling
 *  three different stories about the same gate — which is exactly how the old wording ended up
 *  claiming "has not finished its turn" for a session whose turn was over. */
export const WHY_TEXT: Record<TurnWhy, string> = {
  working: "the recipient is working right now — deferred mail waits for a turn boundary",
  "not-drawn": "the recipient's UI has not painted yet (starting or resuming)",
  "at-menu": "the recipient is at a selection prompt — typing there would pick an option for it",
  settling: "the recipient just spoke; holding a moment to be sure the turn really ended",
  "quiet-unproven": "the recipient's last record is not speech and it has not been quiet long enough to tell a dead turn from a pause",
  "turn-ended": "the recipient finished its turn",
  "idle-after-interrupt": "the recipient's turn was interrupted and will not resume on its own",
  "never-spoke": "the recipient has not taken a turn yet",
};

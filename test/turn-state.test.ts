import { test, expect } from "bun:test";
import { turnState, WHY_TEXT, SETTLE_MS, INTERRUPTED_MS, type TurnFacts } from "../src/chat/turnState.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";

const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  paneWorking: false,
  paneReady: true,
  atMenu: false,
  endedOnAssistantText: true,
  msSinceActivity: SETTLE_MS,
  ...over,
});

// Every case asserts `why`, not just the boolean: a test that only checks `settled` cannot tell a
// real fix from a blanket "always ready", which is the failure this whole change exists to avoid.

test("a live turn is never interrupted, however long its tool runs", () => {
  // The anti-regression test. A naive quiet threshold passes only because the pane is consulted
  // FIRST — so this pins the ordering, not just the outcome.
  const r = turnState(facts({ paneWorking: true, msSinceActivity: 15 * 60_000 }));
  expect(r).toEqual({ settled: false, why: "working" });
});

test("a pane that has not painted yet is never written into", () => {
  // The case that used to lose mail outright: after a restart the pane reads not-working, the
  // transcript is frozen on the killed turn so any quiet threshold is met at once, and delivery
  // ACKS what it types — a keystroke swallowed by a half-drawn UI became a letter marked delivered
  // and never seen again.
  expect(turnState(facts({ paneReady: false, endedOnAssistantText: false, msSinceActivity: 10 * 60_000 })))
    .toEqual({ settled: false, why: "not-drawn" });
});

test("a selection prompt is not an idle session", () => {
  // Reads as not-working (no spinner) and can sit frozen for hours while a human is away.
  expect(turnState(facts({ atMenu: true, msSinceActivity: 60 * 60_000 }))).toEqual({ settled: false, why: "at-menu" });
});

test("an interrupted turn settles — the whole point", () => {
  const r = turnState(facts({ endedOnAssistantText: false, msSinceActivity: INTERRUPTED_MS }));
  expect(r).toEqual({ settled: true, why: "idle-after-interrupt" });
});

test("a clean end settles fast, and the mid-turn gap it was written for still holds", () => {
  expect(turnState(facts({ msSinceActivity: SETTLE_MS }))).toEqual({ settled: true, why: "turn-ended" });
  // A turn is written as separate thinking/text/tool_use records, so "assistant text last" also
  // happens mid-turn — for a second or two.
  expect(turnState(facts({ msSinceActivity: 1_000 }))).toEqual({ settled: false, why: "settling" });
});

test("evidence strength picks the threshold — that is the whole mechanism", () => {
  // Same quiet, opposite verdicts: words are strong evidence a turn ended, a tool result is weak.
  const quiet = SETTLE_MS + 1_000;
  expect(turnState(facts({ endedOnAssistantText: true, msSinceActivity: quiet })).settled).toBe(true);
  expect(turnState(facts({ endedOnAssistantText: false, msSinceActivity: quiet })).settled).toBe(false);
});

test("both sides of both thresholds — silent drift is the classic way a timing rule rots", () => {
  expect(turnState(facts({ msSinceActivity: SETTLE_MS - 1 })).settled).toBe(false);
  expect(turnState(facts({ msSinceActivity: SETTLE_MS })).settled).toBe(true);
  const cut = { endedOnAssistantText: false };
  expect(turnState(facts({ ...cut, msSinceActivity: INTERRUPTED_MS - 1 })).settled).toBe(false);
  expect(turnState(facts({ ...cut, msSinceActivity: INTERRUPTED_MS })).settled).toBe(true);
});

test("a session that never had a turn is its OWN answer, not an interrupted one", () => {
  // No transcript at all: both of the old conditions were false forever, so deferred mail to a
  // freshly created session could never arrive and `wait` on it always timed out. It settles — but
  // calling it "interrupted" would tell a caller a turn was cut short when none ever started.
  expect(turnState(facts({ endedOnAssistantText: false, msSinceActivity: null })))
    .toEqual({ settled: true, why: "never-spoke" });
});

test("silence on a non-speech record is not 'it just spoke'", () => {
  // A session restarted 20s ago: last record is a tool result, quiet is under the horizon. The old
  // shape reported "the recipient just spoke" about a session that had said nothing since it died —
  // the same dishonest hold text this change exists to delete, merely relocated.
  const r = turnState(facts({ endedOnAssistantText: false, msSinceActivity: 20_000 }));
  expect(r).toEqual({ settled: false, why: "quiet-unproven" });
  expect(WHY_TEXT[r.why]).not.toContain("just spoke");
});

test("the interrupted threshold outlives the DEFAULT heal interval — and says so about the real value", () => {
  // For up to one heal cycle after a conversation forks, the registry still points at the frozen old
  // file, so "quiet" there is an artifact rather than evidence. Asserted against the schema default
  // rather than a hardcoded 30_000, because a machine can configure it — and if someone raises
  // `ensureInterval` past this threshold, that is a real (documented) narrowing, not a test to edit.
  const healSec = MachineConfigSchema.parse({
    claudeBin: "/b", tmuxBin: "/t", projectsDir: "/p", rcPrefix: "test", sessionsFile: "/s", bootLabel: "b",
  }).ensureInterval;
  expect(INTERRUPTED_MS).toBeGreaterThan(healSec * 1000);
});

test("every cause has its own sentence, and none of them describes a different cause", () => {
  // A direct encoding of the acceptance item. The failure it guards against is real and happened
  // twice: one sentence serving several gates, asserting something about the turn that was not so.
  const texts = Object.values(WHY_TEXT);
  expect(new Set(texts).size).toBe(texts.length); // no two causes share wording
  // Only the two causes that genuinely mean "a turn is in progress" may say so.
  for (const [why, text] of Object.entries(WHY_TEXT)) {
    const claimsLiveTurn = /just spoke|working right now/.test(text);
    expect(claimsLiveTurn).toBe(why === "settling" || why === "working");
  }
  expect(WHY_TEXT["idle-after-interrupt"]).toContain("interrupted");
  expect(WHY_TEXT["never-spoke"]).toContain("not taken a turn");
});

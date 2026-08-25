import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, buildEvent, feedFiles, parseEvent, readEvents } from "../src/events/feed.ts";
import { lastSignOfLife, observe, shouldCloseTurn, transitions, UNSEEN, type Observed } from "../src/events/observe.ts";
import { INTERRUPTED_MS, turnState } from "../src/chat/turnState.ts";
import { eventForLifecycle, lifecycleToWrite } from "../src/commands/hookStatus.ts";
import { turnStartedAt } from "../src/commands/list.ts";
import { SUPERVISOR_CLOSED_EVENT, closedTurnRecord } from "../src/agent/sessionStatus.ts";
import { formatEvent, framedLine, resolveSince } from "../src/commands/events.ts";
import { eventsEnabledFor } from "../src/config/events.ts";
import { eventsPath } from "../src/config/paths.ts";
import { SessionEventSchema } from "../src/config/schema.ts";
import { makeMachine, makeSession } from "./helpers.ts";
import type { LifecycleStatus } from "../src/agent/sessionStatus.ts";
import { z } from "zod";

// Why a feed at all, measured: every outside surface learned about sessions by polling `list --json`
// — a loop every 3 seconds, capped at 8 sessions, seeing only its own machine. A turn that began and
// ended between two polls left no trace, and "this ran for thirty minutes" cannot be recovered from
// two snapshots. A transition answers that; a snapshot never can.

let dir: string;
const machine = () => makeMachine({ rcPrefix: "host-a", stateDir: dir });
const session = () => makeSession({ name: "agent-a", uuid: "11111111-1111-4111-8111-111111111111" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-events-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ── the record ───────────────────────────────────────────────────────────────────────────────────

test("an event carries the FULL address, so no reader resolves anything against its own machine", () => {
  const e = buildEvent(machine(), session(), { event: "turn-end", durationMs: 1800_000 }, "22222222-2222-4222-8222-222222222222", "2026-08-25T00:00:00.000Z");
  expect(e).toMatchObject({ machine: "host-a", session: "agent-a", agent: "claude", threadId: "11111111-1111-4111-8111-111111111111", event: "turn-end", durationMs: 1800_000 });
  expect(e.id).toBe("22222222-2222-4222-8222-222222222222");
});

test("a record written by a NEWER build still parses here", () => {
  // Strict parsing would turn "they added a field" into "every event after the upgrade is
  // unreadable on this machine" — a fleet-wide silence from a version skew nobody would check.
  const raw = JSON.stringify({
    ...buildEvent(machine(), session(), { event: "turn-start" }, "22222222-2222-4222-8222-222222222222", "2026-08-25T00:00:00.000Z"),
    fieldFromTheFuture: "hello",
  });
  const parsed = parseEvent(raw);
  expect(parsed?.event).toBe("turn-start");
});

test("a torn line costs that line, never the read", () => {
  expect(parseEvent('{"v":1,"id":"broken')).toBeNull();
  expect(parseEvent("   ")).toBeNull();
});

test("appending never throws, even with nowhere to write", () => {
  // Both callers are places where a throw is unaffordable: a hook the agent waits on, and the daemon
  // tick that heals the fleet. A lost line is a lost notification; a thrown error is a stalled turn.
  const broken = makeMachine({ rcPrefix: "host-a", stateDir: "/proc/definitely/not/writable" });
  expect(() => appendEvent(broken, session(), { event: "turn-start" })).not.toThrow();
});

// ── reading, including across a rotation ─────────────────────────────────────────────────────────

test("reads span a rotation, oldest generation first", () => {
  const m = machine();
  mkdirSync(dir, { recursive: true });
  const line = (ts: string, event: string) =>
    `${JSON.stringify(SessionEventSchema.parse({ v: 1, id: "33333333-3333-4333-8333-333333333333", ts, machine: "host-a", session: "agent-a", agent: "claude", threadId: "11111111-1111-4111-8111-111111111111", event }))}\n`;
  writeFileSync(`${eventsPath(m)}.1`, line("2026-08-25T00:00:00.000Z", "turn-start"));
  writeFileSync(eventsPath(m), line("2026-08-25T00:30:00.000Z", "turn-end"));
  expect(feedFiles(m).length).toBe(2);
  expect(readEvents(m).map((e) => e.event)).toEqual(["turn-start", "turn-end"]);
});

test("--since is a TIME, because a byte offset is meaningless the moment the feed rotates", () => {
  const m = machine();
  appendEvent(m, session(), { event: "turn-start" });
  const boundary = new Date().toISOString();
  appendEvent(m, session(), { event: "turn-end" });
  const after = readEvents(m, { since: boundary });
  // At-least-once by design: the boundary instant is re-read rather than risking a gap, which is
  // exactly why every event carries an id for the consumer to dedupe on.
  expect(after.some((e) => e.event === "turn-end")).toBe(true);
});

test("filters by session, and -n keeps the tail", () => {
  const m = machine();
  appendEvent(m, session(), { event: "turn-start" });
  appendEvent(m, makeSession({ name: "agent-b", uuid: "44444444-4444-4444-8444-444444444444" }), { event: "turn-start" });
  expect(readEvents(m, { session: "agent-b" }).length).toBe(1);
  expect(readEvents(m, { limit: 1 })[0]?.session).toBe("agent-b");
});

// ── the hook half: turn boundaries ───────────────────────────────────────────────────────────────

const status = (event: string, state: "working" | "idle", ts: number): LifecycleStatus => ({ state, ts, event });

test("a turn's duration comes from the status the previous hook left — nobody keeps a timer", () => {
  const started = status("UserPromptSubmit", "working", 1_000_000);
  const ended = status("Stop", "idle", 1_000_000 + 1_800_000);
  expect(eventForLifecycle(ended, started)).toEqual({ event: "turn-end", durationMs: 1_800_000 });
  expect(eventForLifecycle(started, null)).toEqual({ event: "turn-start" });
});

test("a turn we never saw start still ends — without an invented duration", () => {
  expect(eventForLifecycle(status("Stop", "idle", 5), null)).toEqual({ event: "turn-end" });
  expect(eventForLifecycle(status("Stop", "idle", 5), status("SessionStart", "idle", 1))).toEqual({ event: "turn-end" });
});

test("a prompt landing INSIDE a running turn does not start another one", () => {
  // Found in the live journal by the transport's owner reading this very feed: three starts 50ms
  // apart, no end between them. A delivered chat message, a watcher's notification or a second
  // question typed after the first all arrive as prompts, and none of them begins a turn.
  const running = status("UserPromptSubmit", "working", 1_000);
  expect(eventForLifecycle(status("UserPromptSubmit", "working", 1_050), running)).toBeNull();
  // …and after the turn ends, the next prompt starts a real one again.
  expect(eventForLifecycle(status("UserPromptSubmit", "working", 9_000), status("Stop", "idle", 8_000))).toEqual({ event: "turn-start" });
});

test("a prompt inside a running turn does not move the turn's start — the duration is not a lie", () => {
  // The worse half of the same defect: the status was rewritten with `now` on every prompt, so the
  // duration measured from the LAST message instead of from the beginning of the work. Plausible on
  // its face, and the busier the session the more it under-reports.
  const started = status("UserPromptSubmit", "working", 1_000);
  const queued = lifecycleToWrite(status("UserPromptSubmit", "working", 1_050), started);
  expect(queued.ts).toBe(1_000);
  // A full turn measured across a queued prompt still reports the real span.
  expect(eventForLifecycle(status("Stop", "idle", 1_801_000), queued)).toEqual({ event: "turn-end", durationMs: 1_800_000 });
});

test("a genuinely new turn keeps its own start instant", () => {
  const fresh = lifecycleToWrite(status("UserPromptSubmit", "working", 5_000), status("Stop", "idle", 4_000));
  expect(fresh.ts).toBe(5_000);
  // …and ending is never rewritten by this rule.
  expect(lifecycleToWrite(status("Stop", "idle", 9_000), status("UserPromptSubmit", "working", 5_000)).ts).toBe(9_000);
});

test("an unmapped hook event says nothing", () => {
  expect(eventForLifecycle(status("PreCompact", "idle", 1), null)).toBeNull();
});

test("a Stop arriving after the supervisor already closed that turn says nothing", () => {
  // Both writers are describing the same ending. A consumer that speaks or blinks on `turn-end`
  // would say it twice, and the second one carries no duration — strictly worse than silence.
  expect(eventForLifecycle(status("Stop", "idle", 9_000), status(SUPERVISOR_CLOSED_EVENT, "idle", 8_000))).toBeNull();
});

test("a supervisor-closed turn does not swallow the NEXT turn's start", () => {
  // The stamp is `idle` again, so the following prompt is a new turn rather than one that joins a
  // turn already running — which is what a stamp left at `working` made it look like.
  const closed = status(SUPERVISOR_CLOSED_EVENT, "idle", 8_000);
  expect(eventForLifecycle(status("UserPromptSubmit", "working", 9_000), closed)).toEqual({ event: "turn-start" });
  expect(lifecycleToWrite(status("UserPromptSubmit", "working", 9_000), closed).ts).toBe(9_000);
});

test("closing a turn keeps what describes the SESSION rather than the turn", () => {
  // A blanked permission mode or transcript path would read as a session that lost them, when all
  // that happened is that its last turn ended without a hook to say so.
  const before: LifecycleStatus = { state: "working", ts: 1_000, event: "UserPromptSubmit", permissionMode: "auto", effort: "high", transcriptPath: "/tmp/t.jsonl" };
  expect(closedTurnRecord(before, 5_000)).toEqual({
    state: "idle",
    ts: 5_000,
    event: SUPERVISOR_CLOSED_EVENT,
    permissionMode: "auto",
    effort: "high",
    transcriptPath: "/tmp/t.jsonl",
  });
});

// ── the snapshot: when the turn that is running now began ────────────────────────────────────────

test("a working session reports an ABSOLUTE instant, so a cached snapshot stays true", () => {
  // Elapsed would go stale in transit — short by exactly the delivery time, and further off the
  // less often the consumer refreshes. An instant reads the same however late it is read.
  expect(turnStartedAt("working", { state: "working", ts: 1_700_000_000_000, event: "UserPromptSubmit" })).toBe("2023-11-14T22:13:20.000Z");
});

test("a session that is not in a turn has no instant at all — not zero, not the last turn's", () => {
  const stampFromAFinishedTurn: LifecycleStatus = { state: "working", ts: 1_000, event: "UserPromptSubmit" };
  expect(turnStartedAt("idle", stampFromAFinishedTurn)).toBeNull();
  expect(turnStartedAt("stopped", stampFromAFinishedTurn)).toBeNull();
  expect(turnStartedAt("idle", null)).toBeNull();
});

test("in a turn whose start nobody recorded, the instant is null and the state still says working", () => {
  // A provider without turn hooks, or a turn already under way when ccmux started. "Working, start
  // unknown" must stay distinguishable from "not working" — the state answers the first half.
  expect(turnStartedAt("working", null)).toBeNull();
  expect(turnStartedAt("working", { state: "idle", ts: 1_000, event: "Stop" })).toBeNull();
});

// ── the observed half: what the hook cannot see ──────────────────────────────────────────────────

const observed = (over: Partial<Observed> = {}): Observed => ({ ...UNSEEN, running: true, ...over });

test("a session stopping is reported, and nothing else is said about a ghost", () => {
  const out = transitions(observed({ waitingAt: "Do you want to proceed?" }), { ...UNSEEN, running: false });
  expect(out).toEqual([{ event: "session-stop" }]);
});

test("waiting at a menu is an event — every other signal reads that session as idle", () => {
  const out = transitions(observed(), observed({ waitingAt: "Do you want to proceed?" }));
  expect(out).toEqual([{ event: "waiting", detail: "Do you want to proceed?" }]);
});

test("leaving the menu closes the pair, because answering a prompt starts no new turn", () => {
  // Without `resumed` a reader would keep that session marked "waiting for you" until its next turn,
  // which can be hours away — a session that needs nothing, shown as one that needs attention.
  expect(transitions(observed({ waitingAt: "Continue?" }), observed())).toEqual([{ event: "resumed" }]);
});

test("an interrupted turn is closed by observation — Stop never fires for one", () => {
  const out = transitions(observed({ turnStartedMs: 1_000 }), observed({ turnStartedMs: 1_000, turnOverMs: 43_000, turnInterrupted: true }));
  expect(out).toEqual([{ event: "turn-end", durationMs: 42_000, interrupted: true }]);
});

test("a turn whose Stop hook never fired is closed too, and is NOT called interrupted", () => {
  // The commonest orphan of all: the turn ended in the agent's own words and only the announcement
  // went missing. Measured on a live machine, four of seven `working` stamps were of this kind, the
  // oldest two and a half days old. Flagging them as interruptions would tell a consumer the fleet
  // is being cut short all day; leaving them open tells it those sessions never stopped working.
  const out = transitions(observed({ turnStartedMs: 1_000 }), observed({ turnStartedMs: 1_000, turnOverMs: 61_000 }));
  expect(out).toEqual([{ event: "turn-end", durationMs: 60_000 }]);
});

test("the duration runs to when the transcript stopped, not to when we noticed", () => {
  // Proof of a dead turn only arrives after a stretch of silence, so "now" is always later than the
  // ending — by the silence, plus however long until a pass looked. An hour of nobody looking used
  // to become an hour of reported work.
  const out = transitions(observed({ turnStartedMs: 0 }), observed({ turnStartedMs: 0, turnOverMs: 30_000 }));
  expect(out).toEqual([{ event: "turn-end", durationMs: 30_000 }]);
});

test("a turn already over the first time we looked is closed silently", () => {
  // The daemon's memory is per-process. A turn that ended while nothing was watching was not
  // witnessed ending, and dating it to the instant a daemon happened to start would publish a
  // two-day-old event as news. The stamp is still closed — see `observeOnce` — just not announced.
  expect(transitions(UNSEEN, observed({ turnStartedMs: 1_000, turnOverMs: 2_000 }))).toEqual([]);
});

test("ONE abandoned turn is announced once, however much the signal flickers", () => {
  // Measured on a live machine before this was deduped by identity: one abandoned turn produced
  // three events in six minutes with a growing duration. The signal is derived from how long the
  // transcript has been quiet, so it drops to false the moment the file stirs and rises again after
  // the next silence — deduping on "was it true last pass" therefore re-announced the same turn.
  const turn = 1_000;
  const announced = observed({ turnStartedMs: turn, turnOverMs: 5_000, turnClosedFor: turn });
  // it flickered off…
  expect(transitions(announced, observed({ turnStartedMs: turn, turnOverMs: null, turnClosedFor: turn }))).toEqual([]);
  // …and back on, still the same turn
  expect(transitions(announced, observed({ turnStartedMs: turn, turnOverMs: 50_000, turnClosedFor: turn }))).toEqual([]);
});

test("a NEW turn abandoned the same way is announced again", () => {
  // The mark is identity, not a permanent silence: a different turn is a different event.
  const prev = observed({ turnStartedMs: 1_000, turnOverMs: 5_000, turnClosedFor: 1_000 });
  const out = transitions(prev, observed({ turnStartedMs: 90_000, turnOverMs: 100_000, turnInterrupted: true }));
  expect(out).toEqual([{ event: "turn-end", durationMs: 10_000, interrupted: true }]);
});

test("steady state emits nothing at all", () => {
  const state = observed({ waitingAt: "Continue?", blocked: "boom" });
  expect(transitions(state, state)).toEqual([]);
  expect(transitions(observed(), observed())).toEqual([]);
});

test("a turning spinner is activity — a long tool call is not a dead turn", () => {
  // Measured on the fleet: a LIVE turn was closed and announced as interrupted 29 seconds after its
  // own pane had been working. The session was four minutes into a tool call, so its transcript was
  // legitimately frozen, and one pass sampled the pane in the instant between the tool finishing and
  // its result being written. On the transcript alone that is indistinguishable from a turn nobody
  // is coming back to; the pane is what tells them apart.
  const now = 10 * 60_000;
  const transcriptFrozenFor = 4 * 60_000;
  const paneWorkingAgo = 29_000;
  const alive = lastSignOfLife(now - transcriptFrozenFor, now - paneWorkingAgo);
  expect(alive).toBe(now - paneWorkingAgo);
  const state = turnState({ paneWorking: false, paneReady: true, atMenu: false, endedOnAssistantText: false, msSinceActivity: now - alive! });
  expect(state).toEqual({ settled: false, why: "quiet-unproven" });
});

test("a turn that really stopped is still proven dead — its pane stopped with it", () => {
  // Nothing is loosened for the case the proof exists for: an abandoned turn has no spinner either,
  // so the window runs from the same instant it always did.
  const now = 10 * 60_000;
  const alive = lastSignOfLife(now - INTERRUPTED_MS - 1, now - INTERRUPTED_MS - 1);
  const state = turnState({ paneWorking: false, paneReady: true, atMenu: false, endedOnAssistantText: false, msSinceActivity: now - alive! });
  expect(state).toEqual({ settled: true, why: "idle-after-interrupt" });
});

test("either source alone still answers, and neither invents an instant", () => {
  expect(lastSignOfLife(null, 5)).toBe(5);
  expect(lastSignOfLife(7, null)).toBe(7);
  expect(lastSignOfLife(null, null)).toBeNull();
});

test("the first look at a session closes nothing — it has no baseline to be a diff against", () => {
  const over = observed({ turnStartedMs: 1_000, turnOverMs: 2_000 });
  expect(shouldCloseTurn(UNSEEN, over)).toBe(false);
  // …and the very next pass, two seconds later, is where an inherited orphan gets closed.
  expect(shouldCloseTurn({ ...UNSEEN, running: true }, over)).toBe(true);
});

test("a turn already closed is not closed again, and a different turn is", () => {
  const prev = observed({ turnClosedFor: 1_000 });
  expect(shouldCloseTurn(prev, observed({ turnStartedMs: 1_000, turnOverMs: 2_000 }))).toBe(false);
  expect(shouldCloseTurn(prev, observed({ turnStartedMs: 9_000, turnOverMs: 9_500 }))).toBe(true);
  expect(shouldCloseTurn(prev, observed({ turnStartedMs: 9_000, turnOverMs: null }))).toBe(false);
});

test("a not-yet-proven quiet turn is NOT reported as interrupted", () => {
  // `settling`/`quiet-unproven` are pauses, not deaths. Reporting them would announce a dead turn
  // every time an agent thinks between tool calls.
  const m = machine();
  const s = session();
  const seen = observe(m, s, true, null, Date.now()); // no pane text → nothing proven
  expect(seen.turnInterrupted).toBe(false);
});

// ── switch and wording ───────────────────────────────────────────────────────────────────────────

test("the two-level switch defaults ON, and a session can opt out", () => {
  const m = makeMachine({ rcPrefix: "host-a" });
  expect(eventsEnabledFor(makeSession(), m)).toBe(true);
  expect(eventsEnabledFor(makeSession({ eventsEnabled: false }), m)).toBe(false);
  expect(eventsEnabledFor(makeSession(), makeMachine({ sessionEvents: false }))).toBe(false);
  expect(eventsEnabledFor(makeSession({ eventsEnabled: true }), makeMachine({ sessionEvents: false }))).toBe(true);
});

test("the human line names the address, the duration and the interruption", () => {
  const e = buildEvent(machine(), session(), { event: "turn-end", durationMs: 1_800_000, interrupted: true }, "22222222-2222-4222-8222-222222222222", "2026-08-25T09:41:07.000Z");
  const line = formatEvent(e);
  expect(line).toContain("host-a:agent-a");
  expect(line).toContain("30m");
  expect(line).toContain("interrupted");
});

// ── the framed envelope a resuming transport requires ────────────────────────────────────────────

// Reproduces the receiving contract exactly as the transport enforces it. It is STRICT there — an
// extra key is a protocol error, not a courtesy — and a `stableCursor` profile refuses at open if a
// line arrives without a cursor. Verified before release: the plain `--json` line does NOT satisfy
// it, so a profile written against `--json` would have failed the moment it opened.
const FramedChunk = z
  .object({
    channel: z.enum(["stdout", "stderr", "data"]).default("data"),
    data: z.string(),
    cursor: z.string().min(1).max(512).nullable().default(null),
  })
  .strict();

test("--framed produces exactly the envelope a resuming transport accepts", () => {
  const event = buildEvent(machine(), session(), { event: "turn-end", durationMs: 1000 }, "22222222-2222-4222-8222-222222222222", "2026-08-25T09:41:07.000Z");
  const line = framedLine(event);
  const parsed = FramedChunk.safeParse(JSON.parse(line));
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  // The cursor is the event's own instant — the same units `--since` takes, so whatever a reader
  // hands back is asking the same question.
  expect(parsed.data.cursor).toBe("2026-08-25T09:41:07.000Z");
  // The payload survives intact, newline included, so the far side can split it back into events.
  expect(JSON.parse(parsed.data.data.trimEnd()).id).toBe(event.id);
});

test("a plain --json line is NOT a framed chunk — the reason the mode exists", () => {
  const event = buildEvent(machine(), session(), { event: "turn-start" }, "22222222-2222-4222-8222-222222222222", "2026-08-25T09:41:07.000Z");
  expect(FramedChunk.safeParse(event).success).toBe(false);
});

// ── resuming a reopened stream ───────────────────────────────────────────────────────────────────

// A feed with no natural end is capped by a deadline, so the transport reopens it on a schedule and
// hands back the cursor through the producer's ENVIRONMENT — the node profile refuses caller-supplied
// arguments, so there is nowhere else to put it. A producer that ignores the variable starts from
// "now" and nothing fails: frames flow, and the gap is silently absent. That is why the resume
// promise cannot be declared until this is read.

test("the transport's resume point is used when no --since was given", () => {
  expect(resolveSince(undefined, "2026-08-25T09:00:00.000Z")).toBe("2026-08-25T09:00:00.000Z");
});

test("an explicit --since wins — a person's question outranks a transport's mechanism", () => {
  expect(resolveSince("2026-08-25T08:00:00.000Z", "2026-08-25T09:00:00.000Z")).toBe("2026-08-25T08:00:00.000Z");
});

test("no variable and no flag leaves the behaviour exactly as it was", () => {
  expect(resolveSince(undefined, undefined)).toBeUndefined();
  // An empty variable is "not set", not "resume from the epoch": the transport clears it that way on
  // a first open, and treating it as a value would replay the entire retained feed on every start.
  expect(resolveSince(undefined, "")).toBeUndefined();
});

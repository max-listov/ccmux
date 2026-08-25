import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, buildEvent, feedFiles, parseEvent, readEvents } from "../src/events/feed.ts";
import { observe, transitions, UNSEEN, type Observed } from "../src/events/observe.ts";
import { eventForLifecycle } from "../src/commands/hookStatus.ts";
import { formatEvent, framedLine } from "../src/commands/events.ts";
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

test("an unmapped hook event says nothing", () => {
  expect(eventForLifecycle(status("PreCompact", "idle", 1), null)).toBeNull();
});

// ── the observed half: what the hook cannot see ──────────────────────────────────────────────────

const observed = (over: Partial<Observed> = {}): Observed => ({ ...UNSEEN, running: true, ...over });

test("a session stopping is reported, and nothing else is said about a ghost", () => {
  const out = transitions(observed({ waitingAt: "Do you want to proceed?" }), { ...UNSEEN, running: false }, 0);
  expect(out).toEqual([{ event: "session-stop" }]);
});

test("waiting at a menu is an event — every other signal reads that session as idle", () => {
  const out = transitions(observed(), observed({ waitingAt: "Do you want to proceed?" }), 0);
  expect(out).toEqual([{ event: "waiting", detail: "Do you want to proceed?" }]);
});

test("leaving the menu closes the pair, because answering a prompt starts no new turn", () => {
  // Without `resumed` a reader would keep that session marked "waiting for you" until its next turn,
  // which can be hours away — a session that needs nothing, shown as one that needs attention.
  expect(transitions(observed({ waitingAt: "Continue?" }), observed(), 0)).toEqual([{ event: "resumed" }]);
});

test("an interrupted turn is closed by observation — Stop never fires for one", () => {
  const out = transitions(observed({ turnStartedMs: 1_000 }), observed({ turnInterrupted: true, turnStartedMs: 1_000 }), 43_000);
  expect(out).toEqual([{ event: "turn-end", interrupted: true, durationMs: 42_000 }]);
});

test("steady state emits nothing at all", () => {
  const state = observed({ waitingAt: "Continue?", blocked: "boom" });
  expect(transitions(state, state, 0)).toEqual([]);
  expect(transitions(observed(), observed(), 0)).toEqual([]);
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

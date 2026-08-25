import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneActivityPath } from "../src/config/paths.ts";
import { paneWorkingSince, readPaneActivity, writePaneActivity } from "../src/events/paneActivity.ts";
import { lastSignOfLife } from "../src/events/observe.ts";
import { INTERRUPTED_MS, turnState } from "../src/chat/turnState.ts";
import { makeMachine } from "./helpers.ts";

// Everything that decides a turn is over decides it from SILENCE — and the transcript is only half
// of what silence means. A session four minutes into a build writes nothing while its pane is
// plainly working. The pane is not a fact one process can check on its own: the spinner is
// instantaneous, so looking once tells you about this moment and nothing before it. Hence a written
// record, kept by the one process that looks at every pane every couple of seconds.

let dir: string;
const machine = () => makeMachine({ rcPrefix: "host-a", stateDir: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccmux-pane-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("what the supervisor saw is what a separate process reads back", async () => {
  const m = machine();
  await writePaneActivity(m, new Map([["agent-a", 1_000], ["agent-b", 2_000]]));
  expect(readPaneActivity(m)).toEqual({ "agent-a": 1_000, "agent-b": 2_000 });
  expect(paneWorkingSince(m, "agent-a")).toBe(1_000);
});

test("a session nobody saw this pass is dropped, not left behind", async () => {
  // The map is rewritten whole. Keeping an entry for a session that no longer exists would leave a
  // stale "was working" instant to be read as evidence about something else with the same name.
  const m = machine();
  await writePaneActivity(m, new Map([["agent-a", 1_000], ["agent-b", 2_000]]));
  await writePaneActivity(m, new Map([["agent-a", 3_000]]));
  expect(readPaneActivity(m)).toEqual({ "agent-a": 3_000 });
  expect(paneWorkingSince(m, "agent-b")).toBeNull();
});

test("no record at all is an answer, not a failure", () => {
  // Before the supervisor's first pass, and on a machine whose supervisor is not running. Readers
  // must degrade to judging by the transcript alone rather than refusing to judge.
  const m = machine();
  expect(readPaneActivity(m)).toEqual({});
  expect(paneWorkingSince(m, "agent-a")).toBeNull();
});

test("an unreadable record is ignored rather than propagated", () => {
  const m = machine();
  writeFileSync(paneActivityPath(m), "{not json");
  expect(readPaneActivity(m)).toEqual({});
});

test("a stale record makes no reader MORE confident than it was", async () => {
  // The failure direction that matters. If the supervisor stops, entries stop advancing — and an old
  // instant contributes nothing to "recently alive", so every reader falls back to the
  // transcript-only answer it used to give. It can never manufacture a turn that looks alive.
  const m = machine();
  const now = 10 * 60_000;
  const quietSince = now - INTERRUPTED_MS - 1;
  await writePaneActivity(m, new Map([["agent-a", quietSince - 60_000]])); // older than the transcript
  const alive = lastSignOfLife(quietSince, paneWorkingSince(m, "agent-a"));
  expect(alive).toBe(quietSince);
  expect(turnState({ paneWorking: false, paneReady: true, atMenu: false, endedOnAssistantText: false, msSinceActivity: now - alive! })).toEqual({
    settled: true,
    why: "idle-after-interrupt",
  });
});

test("a fresh record keeps a long tool call from reading as a turn nobody will finish", async () => {
  // The reason the file exists. `ccmux wait` is a fresh process on every call, so no memory of its
  // own can cover its FIRST look — and a false "done" there sends the caller to
  // `transcript --last-message`, which hands back what was said BEFORE the tool calls that had not
  // finished, as if it were the answer.
  const m = machine();
  const now = 10 * 60_000;
  await writePaneActivity(m, new Map([["agent-a", now - 5_000]]));
  const alive = lastSignOfLife(now - 4 * 60_000, paneWorkingSince(m, "agent-a"));
  expect(turnState({ paneWorking: false, paneReady: true, atMenu: false, endedOnAssistantText: false, msSinceActivity: now - alive! })).toEqual({
    settled: false,
    why: "quiet-unproven",
  });
});

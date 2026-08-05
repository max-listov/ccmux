import { test, expect } from "bun:test";
import { computeStamp, staleReasons } from "../src/agent/launchStamp.ts";
import { MachineConfigSchema, SessionSchema } from "../src/config/schema.ts";

const machine = (over: Record<string, unknown> = {}) =>
  MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "host-a",
    sessionsFile: "/tmp/.ccmux-sessions",
    bootLabel: "b",
    ...over,
  });

const session = (over: Record<string, unknown> = {}) =>
  SessionSchema.parse({
    name: "agent-a",
    dir: "/tmp",
    uuid: "11111111-1111-4111-8111-111111111111",
    ...over,
  });

const stamp = (s = session(), m = machine()) => ({ ...computeStamp(s, m, "ccmux"), ts: 0 });

test("a fresh session is not stale", () => {
  expect(staleReasons(stamp(), computeStamp(session(), machine(), "ccmux"))).toEqual([]);
});

test("no stamp means UNKNOWN, never stale", () => {
  // Sessions launched before stamping existed must not light up: the first upgrade of ccmux itself
  // would otherwise paint the whole fleet red for no reason.
  expect(staleReasons(null, computeStamp(session(), machine(), "ccmux"))).toEqual([]);
});

test("a forked conversation is NOT a config change", () => {
  // Claude re-pins the uuid whenever a conversation forks. It appears in the launch argv, so without
  // normalising it every fork would announce a restart that changes nothing.
  const before = stamp(session({ uuid: "11111111-1111-4111-8111-111111111111" }));
  const after = computeStamp(session({ uuid: "22222222-2222-4222-8222-222222222222" }), machine(), "ccmux");
  expect(staleReasons(before, after)).toEqual([]);
});

test("turning chat on is named as such — the case a version check would miss entirely", () => {
  const before = stamp(session({ chatEnabled: false }));
  const after = computeStamp(session({ chatEnabled: true }), machine(), "ccmux");
  expect(staleReasons(before, after)).toEqual(["chat"]);
});

test("permission mode and prompt modules are named separately", () => {
  const base = stamp();
  expect(staleReasons(base, computeStamp(session({ permissionMode: "plan" }), machine(), "ccmux"))).toContain("mode");
  expect(staleReasons(base, computeStamp(session({ promptModules: ["router"] }), machine(), "ccmux"))).toContain("modules");
});

test("module order is not a change — including for a stamp written before sorting existed", () => {
  const now = computeStamp(session(), machine(), "ccmux");
  const unsorted = { ...stamp(), promptModules: ["router", "alpha"], hash: now.hash };
  const sorted = { ...now, promptModules: ["alpha", "router"] };
  expect(staleReasons(unsorted, sorted)).not.toContain("modules");
});

test("a newer binary reads as 'code'", () => {
  expect(staleReasons({ ...stamp(), version: "0.0.1" }, computeStamp(session(), machine(), "ccmux"))).toContain("code");
});

test("anything else the launch recipe covers surfaces as 'config'", () => {
  // e.g. a reworded prompt or changed extraFlags — reported only when nothing more specific explains
  // it, so the message stays as precise as the evidence allows.
  const before = stamp();
  const after = computeStamp(session(), machine({ extraFlags: ["--verbose"] }), "ccmux");
  expect(staleReasons(before, after)).toEqual(["config"]);
});

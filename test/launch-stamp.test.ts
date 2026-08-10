import { test, expect } from "bun:test";
import { computeStamp, staleReasons } from "../src/agent/launchStamp.ts";
import { MachineConfigSchema, SessionSchema } from "../src/config/schema.ts";

const machine = (over: Record<string, unknown> = {}) =>
  MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "host-a",
    stateDir: "/tmp",
    bootLabel: "b",
    ...over,
  });

const session = (over: Record<string, unknown> = {}) =>
  SessionSchema.parse({
    name: "agent-a",
    dir: "/tmp",
    uuid: "11111111-1111-4111-8111-111111111111",
    agent: "claude",
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

test("a release that changed nothing about this session asks for nothing", () => {
  // Measured, not imagined: a release touching only daemon-side files flagged 22 of 23 live sessions
  // with `code`, and re-launching any of them would have produced a byte-identical recipe. Every
  // in-session effect of an upgrade is already covered — the prompt, `--settings` (inline JSON in
  // argv, not a path), the mode and the flags are all inside the hash, and hooks resolve the binary
  // when they run. So a differing version alone must ask for nothing.
  const older = { ...stamp(), version: "0.0.1" };
  expect(staleReasons(older, computeStamp(session(), machine(), "ccmux"))).toEqual([]);
});

test("an older binary does NOT mask a real change", () => {
  // The other direction: dropping the version check must not swallow a reason. A session launched on
  // an older ccmux whose recipe also changed still reports the actual cause.
  const older = { ...stamp(), version: "0.0.1", chatEnabled: false };
  expect(staleReasons(older, computeStamp(session({ chatEnabled: true }), machine(), "ccmux"))).toEqual(["chat"]);
  const reworded = { ...stamp(), version: "0.0.1" };
  expect(staleReasons(reworded, computeStamp(session(), machine({ extraFlags: ["--verbose"] }), "ccmux"))).toEqual(["config"]);
});

test("anything else the launch recipe covers surfaces as 'config'", () => {
  // e.g. a reworded prompt or changed extraFlags — reported only when nothing more specific explains
  // it, so the message stays as precise as the evidence allows.
  const before = stamp();
  const after = computeStamp(session(), machine({ extraFlags: ["--verbose"] }), "ccmux");
  expect(staleReasons(before, after)).toEqual(["config"]);
});

test("what the launch injects through the ENVIRONMENT is part of the recipe", () => {
  // The gap this closes, measured live: sender authentication is handed to a session at launch via
  // the environment — deliberately not argv, because a secret must not be an argument. So the hash
  // could not see it, and every session started before that capability existed kept RECEIVING while
  // silently unable to SEND. The column said a restart would change nothing.
  const before = { ...stamp(), envKeys: ["CCMUX_SESSION"] };
  expect(staleReasons(before, computeStamp(session(), machine(), "ccmux"))).toEqual(["env"]);
});

test("env keys are compared as a SET — order is not a change", () => {
  const now = computeStamp(session(), machine(), "ccmux");
  const shuffled = { ...stamp(), envKeys: [...(now.envKeys ?? [])].reverse() };
  expect(staleReasons(shuffled, now)).toEqual([]);
});

test("a stamp written before env was recorded is UNKNOWN, never stale", () => {
  // Same doctrine as a missing stamp: a field that did not exist says nothing about that launch.
  // Reporting it as stale would have flagged the whole fleet the moment this field shipped.
  const older = { ...stamp(), envKeys: null };
  expect(staleReasons(older, computeStamp(session(), machine(), "ccmux"))).toEqual([]);
});

test("values never enter the stamp — only names", () => {
  // The capability rotates on every launch and is a secret. Hashing its VALUE would make every
  // session permanently stale AND put a copy of the secret on disk.
  const now = computeStamp(session(), machine(), "ccmux");
  expect(now.envKeys).toEqual([...(now.envKeys ?? [])].sort());
  for (const k of now.envKeys ?? []) expect(k).toMatch(/^[A-Z0-9_]+$/);
});

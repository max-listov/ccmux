import { test, expect } from "bun:test";
import { buildArgv, launchEnv, resolvePermissionMode } from "../src/agent/claude/launch.ts";
import { makeMachine, makeSession } from "./helpers.ts";

test("resume branch flips on historyPresent", () => {
  const s = makeSession();
  const m = makeMachine();
  expect(buildArgv(s, m, "SELF", true)).toContain("--resume");
  expect(buildArgv(s, m, "SELF", true)).not.toContain("--session-id");
  expect(buildArgv(s, m, "SELF", false)).toContain("--session-id");
  expect(buildArgv(s, m, "SELF", false)).not.toContain("--resume");
});

test("default permission-mode is auto, never a bypass token", () => {
  const argv = buildArgv(makeSession(), makeMachine(), "SELF", true);
  const i = argv.indexOf("--permission-mode");
  expect(argv[i + 1]).toBe("auto");
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(argv).not.toContain("--yolo");
});

test("non-root daemon honors the configured permission mode (incl. escalated)", () => {
  // The test runner is non-root, so escalated modes pass through unchanged.
  for (const mode of ["acceptEdits", "plan", "bypassPermissions", "dontAsk"] as const) {
    const argv = buildArgv(makeSession(), makeMachine({ permissionMode: mode }), "SELF", true);
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe(mode);
  }
});

test("per-session permissionMode overrides the machine default; undefined inherits it", () => {
  const m = makeMachine({ permissionMode: "bypassPermissions" });
  // override → the session's mode wins
  const over = buildArgv(makeSession({ permissionMode: "auto" }), m, "SELF", true);
  expect(over[over.indexOf("--permission-mode") + 1]).toBe("auto");
  // no override → machine default
  const inherit = buildArgv(makeSession(), m, "SELF", true);
  expect(inherit[inherit.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
});

test("weird flags survive verbatim — the [1m] glob bug class is structurally gone", () => {
  const s = makeSession({ flags: ["--model", "claude-opus-4-8[1m]"] });
  const argv = buildArgv(s, makeMachine(), "SELF", true);
  expect(argv).toContain("claude-opus-4-8[1m]");
});

test("rc name and ordering: -n <prefix>-<name>, extraFlags after session flags", () => {
  const s = makeSession({ name: "cc-api", flags: ["--a"] });
  const m = makeMachine({ rcPrefix: "prod", extraFlags: ["--z"] });
  const argv = buildArgv(s, m, "SELF", true);
  expect(argv[argv.indexOf("-n") + 1]).toBe("prod-api");
  expect(argv.indexOf("--a")).toBeLessThan(argv.indexOf("--z"));
});

test("settings ALWAYS inject status hooks + statusLine; chat stop-hook coexists on Stop", () => {
  const off = buildArgv(makeSession(), makeMachine(), "ccmux", true);
  const offSettings = off[off.indexOf("--settings") + 1] ?? "";
  for (const t of ["hook-status", "status-line", "UserPromptSubmit", "SessionStart", "Stop"]) {
    expect(offSettings).toContain(t);
  }
  expect(offSettings).not.toContain("stop-hook"); // chat off → no chat hook
  const on = buildArgv(makeSession({ chatEnabled: true }), makeMachine(), "ccmux", true);
  const onSettings = on[on.indexOf("--settings") + 1] ?? "";
  expect(onSettings).toContain("stop-hook"); // chat on → chat hook…
  expect(onSettings).toContain("hook-status"); // …coexists with the status hook (both on Stop)
});

test("launchEnv guarantees a usable PATH + tags the session for the self-guard", () => {
  const env = launchEnv(makeMachine({ claudeBin: "/opt/x/claude", tmuxBin: "/usr/bin/tmux" }), "cc-x");
  expect(env.PATH).toContain("/opt/x");
  expect(env.PATH).toContain("/usr/bin");
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CCMUX_SESSION).toBe("cc-x");
});

// The root guard is a decision, not a veto. It exists so that a config edit ALONE cannot hand a
// server session power over the whole host — the owner can still have it, by saying so once in
// writing. Taken as a pure function because the process's own uid must not decide what is testable.

test("under root, an escalated mode is downgraded — a config edit alone never grants the host", () => {
  const m = makeMachine();
  for (const mode of ["bypassPermissions", "dontAsk"]) {
    expect(resolvePermissionMode(mode, m, true)).toBe("auto");
  }
});

test("a machine that DECLARED it gets exactly what it asked for", () => {
  const m = makeMachine({ allowEscalatedUnderRoot: true });
  for (const mode of ["bypassPermissions", "dontAsk"]) {
    expect(resolvePermissionMode(mode, m, true)).toBe(mode);
  }
});

test("the declaration is per machine — it cannot leak to the ones that never made it", () => {
  // The reason this is a config field and not a deleted guard: one machine wanting escalation must
  // not quietly escalate every other root machine in the fleet.
  expect(resolvePermissionMode("bypassPermissions", makeMachine(), true)).toBe("auto");
});

test("non-escalated modes are untouched in every combination", () => {
  for (const allow of [false, true]) {
    for (const root of [false, true]) {
      const m = makeMachine({ allowEscalatedUnderRoot: allow });
      expect(resolvePermissionMode("plan", m, root)).toBe("plan");
      expect(resolvePermissionMode("auto", m, root)).toBe("auto");
    }
  }
});

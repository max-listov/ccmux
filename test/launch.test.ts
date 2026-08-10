import { test, expect } from "bun:test";
import { buildArgv, launchEnv, resolvePermissionMode, escalationRefusal } from "../src/agent/claude/launch.ts";
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

// Escalated modes under a root daemon are not a policy ccmux chose — the agent itself refuses them
// there. Learned by shipping the opposite: an explicit per-machine opt-out was released, deployed,
// and undone within the hour, because lifting our guard did not grant the capability. It put every
// session on that box into a crash loop with
// "--dangerously-skip-permissions cannot be used with root/sudo privileges".
// So the refusal belongs where the mode is SET; the launcher keeps the downgrade as a last line.

test("the refusal names the AGENT as the reason, not us", () => {
  // If it read as a ccmux policy, the next person would go looking for our switch to flip. There
  // isn't one, and there cannot be.
  const why = escalationRefusal("bypassPermissions", true) ?? "";
  expect(why).toContain("the agent itself refuses");
  expect(why).toContain("non-root");
});

test("both escalated modes are refused under root, and nothing else is", () => {
  for (const mode of ["bypassPermissions", "dontAsk"]) expect(escalationRefusal(mode, true)).not.toBeNull();
  for (const mode of ["auto", "plan", "acceptEdits", "manual"]) expect(escalationRefusal(mode, true)).toBeNull();
});

test("off root, nothing is refused — a personal machine is not a server", () => {
  for (const mode of ["bypassPermissions", "dontAsk", "auto"]) expect(escalationRefusal(mode, false)).toBeNull();
});

test("the launcher still downgrades — defence in depth for a hand-edited config", () => {
  // The setting surface refuses, but a config file can be edited directly. If that reached the
  // launcher unguarded the session would not start at all, which is strictly worse than running
  // guarded and being told about it by doctor.
  expect(resolvePermissionMode("bypassPermissions", true)).toBe("auto");
  expect(resolvePermissionMode("dontAsk", true)).toBe("auto");
  expect(resolvePermissionMode("bypassPermissions", false)).toBe("bypassPermissions");
  expect(resolvePermissionMode("plan", true)).toBe("plan");
});

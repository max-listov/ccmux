import { test, expect } from "bun:test";
import { buildArgv, launchEnv } from "../src/agent/claude/launch.ts";
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

test("launchEnv guarantees a usable PATH + tags the session for the self-guard", () => {
  const env = launchEnv(makeMachine({ claudeBin: "/opt/x/claude", tmuxBin: "/usr/bin/tmux" }), "cc-x");
  expect(env.PATH).toContain("/opt/x");
  expect(env.PATH).toContain("/usr/bin");
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.CCMUX_SESSION).toBe("cc-x");
});

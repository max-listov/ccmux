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

test("argv is always auto permission-mode, never a bypass token", () => {
  const argv = buildArgv(makeSession(), makeMachine(), "SELF", true);
  const i = argv.indexOf("--permission-mode");
  expect(argv[i + 1]).toBe("auto");
  expect(argv).not.toContain("--dangerously-skip-permissions");
  expect(argv).not.toContain("--yolo");
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

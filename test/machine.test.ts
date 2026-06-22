import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rcName, loadMachineConfig } from "../src/config/machine.ts";
import { makeMachine } from "./helpers.ts";

test("rcName: <prefix>-<name without cc->, single strip only", () => {
  const m = makeMachine({ rcPrefix: "prod" });
  expect(rcName(m, "cc-api")).toBe("prod-api");
  expect(rcName(m, "plain")).toBe("prod-plain");
  expect(rcName(m, "cc-cc-x")).toBe("prod-cc-x");
});

test("loadMachineConfig: file over defaults, defaults applied, env override wins", () => {
  const cfg = join(mkdtempSync(join(tmpdir(), "ccmux-mc-")), "machine.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      rcPrefix: "dev",
      claudeBin: "/x/claude",
      tmuxBin: "/x/tmux",
      projectsDir: "/root/.claude/projects",
      sessionsFile: "/x/.ccmux-sessions",
      bootLabel: "ccmux.service",
    }),
  );
  const prevCfg = process.env.CCMUX_CONFIG;
  const prevSess = process.env.CCMUX_SESSIONS;
  process.env.CCMUX_CONFIG = cfg;
  delete process.env.CCMUX_SESSIONS;
  try {
    const m = loadMachineConfig();
    expect(m.rcPrefix).toBe("dev");
    expect(m.ensureInterval).toBe(30); // default applied
    expect(m.permissionMode).toBe("auto");
    expect(m.sessionsFile).toBe("/x/.ccmux-sessions");
    process.env.CCMUX_SESSIONS = "/override/.sessions";
    expect(loadMachineConfig().sessionsFile).toBe("/override/.sessions"); // env wins
  } finally {
    if (prevCfg === undefined) delete process.env.CCMUX_CONFIG;
    else process.env.CCMUX_CONFIG = prevCfg;
    if (prevSess === undefined) delete process.env.CCMUX_SESSIONS;
    else process.env.CCMUX_SESSIONS = prevSess;
  }
});

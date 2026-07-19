import { test, expect } from "bun:test";
import { tmuxArgv } from "../src/tmux/tmux.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";

const cfg = (extra: Record<string, unknown>) =>
  MachineConfigSchema.parse({
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/p",
    rcPrefix: "test",
    sessionsFile: "/s",
    bootLabel: "b",
    ...extra,
  });

test("tmuxArgv without a socket → default socket (no -L), i.e. current prod behaviour", () => {
  expect(tmuxArgv(cfg({}), "list-sessions", "-F", "#{session_name}")).toEqual([
    "/bin/tmux",
    "list-sessions",
    "-F",
    "#{session_name}",
  ]);
});

test("tmuxArgv with tmuxSocket → every call scoped to that socket via -L", () => {
  expect(tmuxArgv(cfg({ tmuxSocket: "ccmux-dev" }), "new-session", "-d", "-s", "dev-a")).toEqual([
    "/bin/tmux",
    "-L",
    "ccmux-dev",
    "new-session",
    "-d",
    "-s",
    "dev-a",
  ]);
});

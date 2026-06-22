import { test, expect } from "bun:test";
import { SessionSchema, MachineConfigSchema } from "../src/config/schema.ts";

const UUID = "11111111-1111-4111-8111-111111111111";

test("SessionSchema applies defaults", () => {
  const s = SessionSchema.parse({ name: "cc-x", dir: "/home/user", uuid: UUID });
  expect(s.flags).toEqual([]);
  expect(s.archived).toBe(false);
  expect(s.resumeText).toBe("continue");
});

test("SessionSchema preserves weird flags verbatim (the [1m] glob bug class is gone)", () => {
  const s = SessionSchema.parse({
    name: "cc-x",
    dir: "/home/user",
    uuid: UUID,
    flags: ["--model", "claude-opus-4-8[1m]"],
  });
  expect(s.flags).toEqual(["--model", "claude-opus-4-8[1m]"]);
});

test("SessionSchema rejects bad names / relative dir / bad uuid", () => {
  expect(() => SessionSchema.parse({ name: "a|b", dir: "/x", uuid: UUID })).toThrow();
  expect(() => SessionSchema.parse({ name: "a b", dir: "/x", uuid: UUID })).toThrow();
  expect(() => SessionSchema.parse({ name: "cc-x", dir: "rel/path", uuid: UUID })).toThrow();
  expect(() => SessionSchema.parse({ name: "cc-x", dir: "/x", uuid: "not-a-uuid" })).toThrow();
});

test("MachineConfig: permissionMode is locked to auto — config cannot escalate", () => {
  const base = {
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/root/.claude/projects",
    rcPrefix: "prod",
    sessionsFile: "/home/user/.ccmux-sessions",
    bootLabel: "ccmux.service",
  };
  const m = MachineConfigSchema.parse(base);
  expect(m.permissionMode).toBe("auto");
  expect(m.ensureInterval).toBe(30);
  expect(() => MachineConfigSchema.parse({ ...base, permissionMode: "yolo" })).toThrow();
});

test("MachineConfig: rcPrefix is a required enum", () => {
  const base = {
    claudeBin: "/bin/claude",
    tmuxBin: "/bin/tmux",
    projectsDir: "/root/.claude/projects",
    sessionsFile: "/home/user/.ccmux-sessions",
    bootLabel: "ccmux.service",
  };
  expect(() => MachineConfigSchema.parse({ ...base, rcPrefix: "staging" })).toThrow();
  expect(MachineConfigSchema.parse({ ...base, rcPrefix: "dev" }).rcPrefix).toBe("dev");
});

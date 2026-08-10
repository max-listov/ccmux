import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSessions } from "../src/config/sessions.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ccmux-new-"));
  const project = join(root, "project");
  mkdirSync(project);
  const tmux = join(root, "tmux");
  writeFileSync(tmux, "#!/bin/sh\nexit 0\n");
  chmodSync(tmux, 0o700);
  const machine = MachineConfigSchema.parse({
    claudeBin: tmux,
    codexBin: "/bin/codex",
    tmuxBin: tmux,
    projectsDir: join(root, "claude"),
    codexSessionsDir: join(root, "codex"),
    rcPrefix: "host-a",
    stateDir: join(root, "state"),
    bootLabel: "ccmux.service",
  });
  const config = join(root, "machine.json");
  writeFileSync(config, JSON.stringify(machine));
  return { config, machine, project };
}

async function run(config: string, args: string[]): Promise<number> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = config;
  const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  await new Response(proc.stdout).text();
  return proc.exited;
}

test("new records an explicit provider on the real command path", async () => {
  const { config, machine, project } = setup();
  expect(await run(config, ["new", "agent-a", project, "--agent", "claude"])).toBe(0);
  expect(loadSessions(machine)).toHaveLength(1);
  expect(loadSessions(machine)[0]?.agent).toBe("claude");
});

test("new fails rather than guessing when --agent has no value", async () => {
  const { config, machine, project } = setup();
  expect(await run(config, ["new", "agent-a", project, "--agent"])).toBe(1);
  expect(loadSessions(machine)).toEqual([]);
});

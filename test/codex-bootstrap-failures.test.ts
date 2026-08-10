import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { loadPendingSessions, reservePendingSession } from "../src/config/pendingSessions.ts";
import { lifecycleBlockPath } from "../src/config/paths.ts";
import { MachineConfigSchema, PendingSessionSchema } from "../src/config/schema.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { hasSession, tmuxArgv } from "../src/tmux/tmux.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
type FailureMode = "crash" | "timeout" | "ambiguous";

function fakeCodex(mode: FailureMode, path: string, codexSessionsDir: string, invocationPath: string): void {
  const common = [
    "#!/bin/sh",
    `printf "1\\n" >> "${invocationPath}"`,
  ];
  const behavior = mode === "crash"
    ? ["exit 17"]
    : mode === "timeout"
      ? ["sleep 30"]
      : [
          `mkdir -p "${codexSessionsDir}/probe"`,
          `printf '{"type":"session_meta","payload":{"id":"11111111-1111-4111-8111-111111111111","originator":"%s"}}\\n' "$CODEX_INTERNAL_ORIGINATOR_OVERRIDE" > "${codexSessionsDir}/probe/rollout-a-11111111-1111-4111-8111-111111111111.jsonl"`,
          `printf '{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222","originator":"%s"}}\\n' "$CODEX_INTERNAL_ORIGINATOR_OVERRIDE" > "${codexSessionsDir}/probe/rollout-b-22222222-2222-4222-8222-222222222222.jsonl"`,
          "sleep 30",
        ];
  writeFileSync(path, `${[...common, ...behavior].join("\n")}\n`);
  chmodSync(path, 0o700);
}

async function runFailure(mode: FailureMode): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), `ccmux-codex-${mode}-`));
  const work = join(root, "work");
  const stateDir = join(root, "state");
  const codexHome = join(root, "codex-home");
  const codexSessionsDir = join(codexHome, "sessions");
  const fake = join(root, "codex");
  const invocationPath = join(root, "invocations");
  const configPath = join(root, "machine.json");
  const tmuxBin = Bun.which("tmux");
  if (!tmuxBin) throw new Error("tmux is required for bootstrap failure integration tests");
  for (const dir of [work, stateDir, codexSessionsDir]) mkdirSync(dir, { recursive: true });
  fakeCodex(mode, fake, codexSessionsDir, invocationPath);
  const machine = MachineConfigSchema.parse({
    claudeBin: "/bin/sh",
    codexBin: fake,
    tmuxBin,
    tmuxSocket: `ccmux-codex-${mode}-${process.pid}`,
    projectsDir: join(root, "claude-projects"),
    codexHome,
    codexSessionsDir,
    stateDir,
    rcPrefix: "host-a",
    bootLabel: "ccmux-probe.service",
    remoteControl: false,
    autoUpdate: false,
    codexCorrelationTimeoutMs: 1_500,
  });
  writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  env.CCMUX_STATE_DIR = stateDir;
  env.CCMUX_CACHE_DIR = join(root, "cache");
  env.CODEX_HOME = codexHome;

  try {
    const proc = Bun.spawn(["bun", CLI, "new", "agent-a", work, "--agent", "codex"], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    const logPath = join(stateDir, "ccmux.log");
    const stateLog = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const output = `${await stdout}\n${await stderr}\n${stateLog}`;
    expect(output).toContain(mode === "crash"
      ? "exited before writing session_meta"
      : mode === "timeout"
        ? "correlation timed out"
        : "refusing ambiguous promotion");
    expect(loadSessions(machine)).toEqual([]);
    expect(loadPendingSessions(machine)).toEqual([]);
    expect(await hasSession(machine, "agent-a")).toBe(false);
    expect(existsSync(lifecycleBlockPath(machine, "agent-a"))).toBe(false);
    expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toHaveLength(1);
    const rollouts = [...new Glob("**/rollout-*.jsonl").scanSync({ cwd: codexSessionsDir })];
    expect(rollouts).toHaveLength(mode === "ambiguous" ? 2 : 0);
  } finally {
    Bun.spawnSync(tmuxArgv(machine, "kill-server"), { stdout: "ignore", stderr: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
}

test("fresh Codex child crash rolls back once without lifecycle residue", () => runFailure("crash"));
test("fresh Codex correlation timeout kills the only child and rolls back", () => runFailure("timeout"));
test("ambiguous persisted markers preserve rollouts but never promote either UUID", () => runFailure("ambiguous"));

test("bootstrap performs exact-generation cleanup even when no initiating CLI is alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccmux-codex-orphan-bootstrap-"));
  const work = join(root, "work");
  const stateDir = join(root, "state");
  const codexHome = join(root, "codex-home");
  const codexSessionsDir = join(codexHome, "sessions");
  const fake = join(root, "codex");
  const invocationPath = join(root, "invocations");
  const configPath = join(root, "machine.json");
  const generation = "33333333-3333-4333-8333-333333333333";
  const tmuxBin = Bun.which("tmux");
  if (!tmuxBin) throw new Error("tmux is required for bootstrap failure integration tests");
  for (const dir of [work, stateDir, codexSessionsDir]) mkdirSync(dir, { recursive: true });
  fakeCodex("crash", fake, codexSessionsDir, invocationPath);
  const machine = MachineConfigSchema.parse({
    claudeBin: "/bin/sh",
    codexBin: fake,
    tmuxBin,
    tmuxSocket: `ccmux-codex-orphan-${process.pid}`,
    projectsDir: join(root, "claude-projects"),
    codexHome,
    codexSessionsDir,
    stateDir,
    rcPrefix: "host-a",
    bootLabel: "ccmux-probe.service",
    remoteControl: false,
    autoUpdate: false,
    codexCorrelationTimeoutMs: 1_500,
  });
  writeFileSync(configPath, `${JSON.stringify(machine)}\n`);
  await reservePendingSession(machine, PendingSessionSchema.parse({
    generation,
    marker: `ccmux_${generation}`,
    operation: { kind: "create" },
    session: { name: "agent-a", dir: work, agent: "codex", flags: [] },
    createdAt: "2026-08-10T00:00:00.000Z",
    status: "pending",
  }));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.CCMUX_CONFIG = configPath;
  env.CCMUX_STATE_DIR = stateDir;
  env.CCMUX_CACHE_DIR = join(root, "cache");
  env.CODEX_HOME = codexHome;

  try {
    const proc = Bun.spawn(["bun", CLI, "_bootstrap", generation], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(loadPendingSessions(machine)).toEqual([]);
    expect(loadSessions(machine)).toEqual([]);
    expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(lifecycleBlockPath(machine, "agent-a"))).toBe(true);
  } finally {
    Bun.spawnSync(tmuxArgv(machine, "kill-server"), { stdout: "ignore", stderr: "ignore" });
    rmSync(root, { recursive: true, force: true });
  }
});

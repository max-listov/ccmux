#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { ListJsonSchema, MachineConfigSchema, SessionSchema } from "../src/config/schema.ts";
import { readSession } from "../src/lib.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const root = mkdtempSync(join(tmpdir(), "ccmux-codex-lifecycle-"));
const work = join(root, "work");
const codexHome = join(root, "codex-home");
const codexSessions = join(codexHome, "sessions");
const stateDir = join(root, "state");
const cacheDir = join(root, "cache");
const configPath = join(root, "machine.json");
const tmuxSocket = `ccmux-lifecycle-${process.pid}`;
const codexBin = Bun.which("codex");
const claudeBin = Bun.which("claude");
const tmuxBin = Bun.which("tmux");
const children = new Set<ReturnType<typeof Bun.spawn>>();
let daemon: ReturnType<typeof Bun.spawn> | null = null;

try {
for (const path of [work, codexSessions, stateDir, cacheDir]) mkdirSync(path, { recursive: true });
copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));

if (!codexBin || !claudeBin || !tmuxBin) throw new Error("probe requires codex, claude, and tmux in PATH");
const machine = MachineConfigSchema.parse({
  claudeBin,
  codexBin,
  tmuxBin,
  tmuxSocket,
  projectsDir: join(root, "claude-projects"),
  codexSessionsDir: codexSessions,
  rcPrefix: "host-a",
  stateDir,
  bootLabel: "ccmux-probe.service",
  autoUpdate: false,
  remoteControl: false,
  ensureInterval: 1,
  extraFlags: ["-s", "read-only", "-a", "never", "--no-alt-screen"],
});
await Bun.write(configPath, `${JSON.stringify(machine, null, 2)}\n`);

const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
env.CCMUX_CONFIG = configPath;
env.CCMUX_STATE_DIR = stateDir;
env.CCMUX_CACHE_DIR = cacheDir;
env.CODEX_HOME = codexHome;

type CommandResult = { code: number; stdout: string; stderr: string };
function spawn(argv: string[]) {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  children.add(child);
  void child.exited.then(() => children.delete(child));
  return child;
}

async function run(argv: string[]): Promise<CommandResult> {
  const child = spawn(argv);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await Promise.race([
    child.exited,
    Bun.sleep(60_000).then(() => {
      child.kill("SIGKILL");
      throw new Error(`command timed out: ${argv.join(" ")}`);
    }),
  ]);
  return { code, stdout: await stdout, stderr: await stderr };
}

const cli = (...args: string[]) => run(["bun", CLI, ...args]);
const tmux = (...args: string[]) => run([tmuxBin, "-L", tmuxSocket, ...args]);

async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

function registry(): Array<{ name: string; uuid: string; agent: string }> {
  const path = join(stateDir, "sessions.jsonl");
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.startsWith("{")).map((line) => SessionSchema.parse(JSON.parse(line)));
  } catch {
    return [];
  }
}

function rolloutPaths(): string[] {
  return [...new Glob("**/rollout-*.jsonl").scanSync({ cwd: codexSessions, absolute: true })];
}

function rolloutFor(uuid: string): string {
  const path = rolloutPaths().find((item) => item.endsWith(`-${uuid}.jsonl`));
  if (!path) throw new Error(`rollout not found for ${uuid}`);
  return path;
}

function assertIdentity(name: string, uuid: string): void {
  const session = registry().find((item) => item.name === name);
  if (!session || session.uuid !== uuid || session.agent !== "codex") {
    throw new Error(`${name} lost its provider/UUID identity`);
  }
  rolloutFor(uuid);
}

function hasAssistantExact(uuid: string, expected: string): boolean {
  return readSession(rolloutFor(uuid), "codex").some((message) => (
    message.role === "assistant" && message.kind === "message" && message.text?.trim() === expected
  ));
}

async function turnAndWait(name: string, uuid: string, expected: string): Promise<void> {
  await waitFor(`${name} ready for ${expected}`, async () => (await pane(name)).includes("›"));
  // capture-pane retains the previous frame across a child restart. Give the newly observed
  // Codex process time to finish loading the bound rollout before typing into its TUI.
  await Bun.sleep(2_000);
  const sent = await cli("send", name, `Reply exactly ${expected}`);
  if (sent.code !== 0) throw new Error(`send failed: ${sent.stderr || sent.stdout}`);
  await waitFor(`assistant ${expected}`, () => hasAssistantExact(uuid, expected), 60_000);
  assertIdentity(name, uuid);
}

async function listed(name: string) {
  const result = await cli("list", "--json");
  if (result.code !== 0) throw new Error(`list --json failed: ${result.stderr || result.stdout}`);
  return ListJsonSchema.parse(JSON.parse(result.stdout)).sessions.find((session) => session.name === name);
}

async function hasSession(name: string): Promise<boolean> {
  return (await tmux("has-session", "-t", `=${name}`)).code === 0;
}

async function pane(name: string): Promise<string> {
  return (await tmux("capture-pane", "-p", "-t", `=${name}:0.0`, "-S", "-40")).stdout;
}

async function approveTrust(name: string): Promise<void> {
  let sent = false;
  await waitFor(`${name} trust or bind`, async () => {
    const bound = registry().some((item) => item.name === name);
    if (bound) return true;
    const text = await pane(name);
    if (!sent && text.includes("project-local config, hooks") && text.includes("Press enter to continue")) {
      sent = true;
      await tmux("send-keys", "-t", `=${name}:0.0`, "1", "Enter");
    }
    return false;
  });
}

async function createCodex(name: string): Promise<CommandResult> {
  const child = spawn(["bun", CLI, "new", name, work, "--agent", "codex"]);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  await approveTrust(name);
  return { code: await child.exited, stdout: await stdout, stderr: await stderr };
}

async function panePid(name: string): Promise<number> {
  const result = await tmux("display-message", "-p", "-t", `=${name}:0.0`, "#{pane_pid}");
  return Number.parseInt(result.stdout.trim(), 10);
}

async function childPid(parent: number): Promise<number | null> {
  const result = await run(["pgrep", "-P", String(parent)]);
  const pid = Number.parseInt(result.stdout.trim().split("\n")[0] ?? "", 10);
  return Number.isInteger(pid) ? pid : null;
}

  const first = await createCodex("agent-a");
  if (first.code !== 0) throw new Error(`CLI create failed: ${first.stderr || first.stdout}`);
  const ready = registry().find((item) => item.name === "agent-a");
  if (!ready || ready.agent !== "codex") throw new Error("agent-a was not promoted as Codex");
  const uuid = ready.uuid;
  rolloutFor(uuid);

  const initialRolloutCount = rolloutPaths().length;
  await turnAndWait("agent-a", uuid, "LIFECYCLE_OK");

  const supervisor = await panePid("agent-a");
  const firstChild = await childPid(supervisor);
  if (firstChild === null) throw new Error(`child pid not found for ${supervisor}`);
  process.kill(firstChild, "SIGTERM");
  await waitFor("child resume", async () => {
    const current = await childPid(supervisor);
    return current !== null && current !== firstChild;
  });
  if (rolloutPaths().length !== initialRolloutCount) throw new Error("child death minted a new rollout");
  await turnAndWait("agent-a", uuid, "CHILD_RESUME_OK");

  const stopped = await cli("stop", "agent-a");
  if (stopped.code !== 0) throw new Error(`stop failed: ${stopped.stderr || stopped.stdout}`);
  await waitFor("explicit stop", async () => !(await hasSession("agent-a")));
  const started = await cli("start", "agent-a");
  if (started.code !== 0) throw new Error(`start failed: ${started.stderr || started.stdout}`);
  await waitFor("explicit start", () => hasSession("agent-a"));
  await turnAndWait("agent-a", uuid, "STOP_START_OK");

  const beforeRestartPid = await panePid("agent-a");
  const restarted = await cli("restart", "agent-a");
  if (restarted.code !== 0) throw new Error(`restart failed: ${restarted.stderr || restarted.stdout}`);
  await waitFor("single restart", async () => (await hasSession("agent-a")) && (await panePid("agent-a")) !== beforeRestartPid);
  await turnAndWait("agent-a", uuid, "SINGLE_RESTART_OK");

  const beforeAllPid = await panePid("agent-a");
  const restartAll = await cli("restart", "--all");
  if (restartAll.code !== 0) throw new Error(`restart --all failed: ${restartAll.stderr || restartAll.stdout}`);
  await waitFor("restart all", async () => (await hasSession("agent-a")) && (await panePid("agent-a")) !== beforeAllPid);
  await turnAndWait("agent-a", uuid, "RESTART_ALL_OK");

  daemon = spawn(["bun", CLI, "daemon"]);
  await Bun.sleep(300);
  await tmux("kill-session", "-t", "=agent-a");
  await waitFor("daemon tmux heal", () => hasSession("agent-a"), 10_000);
  await waitFor("daemon-healed writer admission", () => existsSync(join(codexHome, "thread-writer-locks", `${uuid}.lock`)));
  await turnAndWait("agent-a", uuid, "DAEMON_HEAL_OK");

  const contender = await tmux(
    "new-session", "-d", "-s", "contender", "-c", work,
    "-e", `CODEX_HOME=${codexHome}`,
    `codex --no-alt-screen resume ${uuid}; printf '\nCONTENDER_EXIT=%s\n' $?; sleep 3`,
  );
  if (contender.code !== 0) throw new Error(`contender tmux failed: ${contender.stderr}`);
  await waitFor("active writer refusal", async () => (await pane("contender")).includes("already has an active writer"));

  const a = spawn(["bun", CLI, "new", "agent-b", work, "--agent", "codex"]);
  const b = spawn(["bun", CLI, "new", "agent-c", work, "--agent", "codex"]);
  const aOut = new Response(a.stdout).text();
  const bOut = new Response(b.stdout).text();
  const aErr = new Response(a.stderr).text();
  const bErr = new Response(b.stderr).text();
  await Promise.all([approveTrust("agent-b"), approveTrust("agent-c")]);
  const [aCode, bCode] = await Promise.all([a.exited, b.exited]);
  if (aCode !== 0) throw new Error(`agent-b create failed: ${await aErr}${await aOut}`);
  if (bCode !== 0) throw new Error(`agent-c create failed: ${await bErr}${await bOut}`);
  const sessionB = registry().find((item) => item.name === "agent-b");
  const sessionC = registry().find((item) => item.name === "agent-c");
  if (!sessionB || !sessionC || sessionB.uuid === sessionC.uuid) throw new Error("concurrent sessions did not bind distinct UUIDs");
  await waitFor("same-cwd management prompts", () => {
    const textB = readFileSync(rolloutFor(sessionB.uuid), "utf8");
    const textC = readFileSync(rolloutFor(sessionC.uuid), "utf8");
    return textB.includes("agent-b") && textC.includes("agent-c");
  });

  daemon.kill();
  await daemon.exited;
  daemon = null;
  const stoppedForConflict = await cli("stop", "agent-a");
  if (stoppedForConflict.code !== 0) throw new Error(`conflict setup stop failed: ${stoppedForConflict.stderr}`);
  const externalOwner = await tmux(
    "new-session", "-d", "-s", "external-owner", "-c", work,
    "-e", `CODEX_HOME=${codexHome}`,
    `codex --no-alt-screen resume ${uuid}`,
  );
  if (externalOwner.code !== 0) throw new Error(`external owner failed: ${externalOwner.stderr}`);
  await waitFor("external owner admitted", async () => (await pane("external-owner")).includes("›"));
  const conflictedStart = await cli("start", "agent-a");
  if (conflictedStart.code !== 0) throw new Error(`managed conflict start command failed: ${conflictedStart.stderr}`);
  await waitFor("managed writer conflict blocked", async () => (await listed("agent-a"))?.state === "blocked");
  const conflictRow = await listed("agent-a");
  if (!conflictRow?.lifecycleError?.includes("active writer")) throw new Error("blocked writer reason is not observable");
  await Bun.sleep(2_500);
  if (await hasSession("agent-a")) throw new Error("blocked managed writer entered a retry storm");
  await tmux("kill-session", "-t", "=external-owner");
  const resumedAfterConflict = await cli("start", "agent-a");
  if (resumedAfterConflict.code !== 0) throw new Error(`resume after writer release failed: ${resumedAfterConflict.stderr}`);
  await turnAndWait("agent-a", uuid, "WRITER_RELEASE_OK");

  const heldRollout = rolloutFor(sessionB.uuid);
  const heldPath = `${heldRollout}.held`;
  const stoppedForMissing = await cli("stop", "agent-b");
  if (stoppedForMissing.code !== 0) throw new Error(`missing-history setup stop failed: ${stoppedForMissing.stderr}`);
  renameSync(heldRollout, heldPath);
  try {
    const missingStart = await cli("start", "agent-b");
    if (missingStart.code !== 0) throw new Error(`missing-history start command failed: ${missingStart.stderr}`);
    await waitFor("missing history blocked", async () => (await listed("agent-b"))?.state === "blocked");
    const missingRow = await listed("agent-b");
    if (!missingRow?.lifecycleError?.includes("missing rollout")) throw new Error("missing-history reason is not observable");
  } finally {
    renameSync(heldPath, heldRollout);
  }
  const recoveredMissing = await cli("start", "agent-b");
  if (recoveredMissing.code !== 0) throw new Error(`missing-history recovery failed: ${recoveredMissing.stderr}`);
  assertIdentity("agent-b", sessionB.uuid);

  console.log(JSON.stringify({
    codexVersion: (await run([codexBin, "--version"])).stdout.trim(),
    cliCreateBound: true,
    childDeathResumedSameUuid: true,
    stopStartSameUuid: true,
    singleRestartSameUuid: true,
    restartAllSameUuid: true,
    daemonHealSameUuid: true,
    activeWriterRejected: true,
    managedWriterConflictBlocked: true,
    missingHistoryBlocked: true,
    concurrentSameCwdDistinct: true,
    rolloutCount: rolloutPaths().length,
  }));
} finally {
  daemon?.kill();
  const live = [...children];
  for (const child of live) child.kill();
  await Promise.allSettled(live.map(async (child) => {
    await Promise.race([child.exited, Bun.sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }));
  if (tmuxBin) Bun.spawnSync([tmuxBin, "-L", tmuxSocket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
  if (process.env.CCMUX_PROBE_KEEP === "1") console.error(`probe files kept at ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

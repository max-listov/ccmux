#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Glob } from "bun";
import { z } from "zod";
import { readSession } from "../src/lib.ts";
import { MachineConfigSchema } from "../src/config/schema.ts";
import { loadSessions } from "../src/config/sessions.ts";
import { loadPendingSessions } from "../src/config/pendingSessions.ts";

const COMMAND_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 90_000;
const EXIT_TIMEOUT_MS = 5_000;

const SessionMetaSchema = z.object({
  type: z.literal("session_meta"),
  payload: z
    .object({
      id: z.uuid(),
      source: z.unknown(),
      forked_from_id: z.uuid().nullable().optional(),
    })
    .passthrough(),
});

const RpcMessageSchema = z
  .object({
    id: z.number().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
  })
  .passthrough();

type CommandResult = { code: number; stdout: string; stderr: string };
type Rollout = { path: string; id: string; source: unknown; forkedFrom: string | null };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeout()), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function cleanEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return { ...env, ...overrides };
}

async function boundedRun(argv: string[], env: Record<string, string>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const code = await withTimeout(child.exited, timeoutMs, () => {
      child.kill("SIGKILL");
      return new Error("bounded command timed out");
  });
  return { code, stdout: await stdout, stderr: await stderr };
}

async function waitFor(label: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`timeout while waiting for ${label}`);
}

function startAppServer(codexBin: string, env: Record<string, string>) {
  const child = Bun.spawn([codexBin, "app-server", "--stdio"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let buffer = "";
  let stopped = false;

  const stdoutDone = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        const message = RpcMessageSchema.parse(JSON.parse(line));
        if (message.id === undefined) continue;
        const request = pending.get(message.id);
        if (request === undefined) continue;
        pending.delete(message.id);
        if (message.error !== undefined) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
    }
  })();
  const stderrDone = new Response(child.stderr).text();

  function request(method: string, params: object): Promise<unknown> {
    const id = nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    return withTimeout(response, COMMAND_TIMEOUT_MS, () => {
      pending.delete(id);
      return new Error(`app-server request timed out: ${method}`);
    });
  }

  async function initialize(): Promise<void> {
    await request("initialize", { clientInfo: { name: "ccmux_ownership_probe", version: "1" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  }

  async function terminate(): Promise<void> {
    if (stopped) return;
    stopped = true;
    try {
      child.stdin.end();
    } catch {
      // The process may already have closed its input.
    }
    let code = await Promise.race([child.exited, Bun.sleep(EXIT_TIMEOUT_MS).then(() => null)]);
    if (code === null) {
      child.kill("SIGTERM");
      code = await Promise.race([child.exited, Bun.sleep(EXIT_TIMEOUT_MS).then(() => null)]);
    }
    if (code === null) {
      child.kill("SIGKILL");
      code = await Promise.race([child.exited, Bun.sleep(EXIT_TIMEOUT_MS).then(() => null)]);
    }
    if (code === null) throw new Error("app-server did not terminate");
    for (const request of pending.values()) request.reject(new Error("app-server terminated"));
    pending.clear();
    await Promise.race([Promise.allSettled([stdoutDone, stderrDone]), Bun.sleep(EXIT_TIMEOUT_MS)]);
  }

  return { initialize, request, terminate };
}

async function main(): Promise<void> {
  const codexBin = Bun.which("codex");
  const tmuxBin = Bun.which("tmux");
  if (codexBin === null || tmuxBin === null) throw new Error("probe requires codex and tmux");
  const resolvedCodexBin = codexBin;
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const allSessions = ["source-owner", "managed-held", "managed-appserver-held", "managed-fork", "managed-adopt"];
  let root: string | null = null;
  let tmux: ((...args: string[]) => Promise<CommandResult>) | null = null;
  let appServer: ReturnType<typeof startAppServer> | null = null;
  let primaryError: unknown = null;
  let output: Record<string, string | boolean> | null = null;

  try {
    root = mkdtempSync(join(tmpdir(), "ccmux-codex-ownership-"));
    const workspace = join(root, "workspace");
    const codexHome = join(root, "codex-home");
    const codexSessions = join(codexHome, "sessions");
    const stateDir = join(root, "state");
    const cacheDir = join(root, "cache");
    const configPath = join(root, "machine.json");
    const tmuxSocket = `ccmux-ownership-${process.pid}`;
    for (const path of [workspace, codexSessions, stateDir, cacheDir]) mkdirSync(path, { recursive: true });
    copyFileSync(join(homedir(), ".codex", "auth.json"), join(codexHome, "auth.json"));
    const machine = MachineConfigSchema.parse({
      claudeBin: "/bin/false",
      codexBin: resolvedCodexBin,
      tmuxBin,
      tmuxSocket,
      projectsDir: join(root, "claude-projects"),
      codexHome,
      codexSessionsDir: codexSessions,
      stateDir,
      rcPrefix: "probe-host",
      bootLabel: "ccmux-probe.service",
      remoteControl: false,
      autoUpdate: false,
      codexCorrelationTimeoutMs: COMMAND_TIMEOUT_MS,
      extraFlags: ["-s", "read-only", "-a", "never", "--no-alt-screen"],
    });
    await Bun.write(configPath, `${JSON.stringify(machine)}\n`);
    const env = cleanEnv({
      CODEX_HOME: codexHome,
      CCMUX_CONFIG: configPath,
      CCMUX_STATE_DIR: stateDir,
      CCMUX_CACHE_DIR: cacheDir,
    });
    tmux = (...args: string[]) => boundedRun([tmuxBin, "-L", tmuxSocket, ...args], env);

    function rollouts(): Rollout[] {
      const records: Rollout[] = [];
      for (const path of new Glob("**/rollout-*.jsonl").scanSync({ cwd: codexSessions, absolute: true })) {
        const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
        if (firstLine === undefined || firstLine === "") continue;
        const parsed = SessionMetaSchema.parse(JSON.parse(firstLine));
        records.push({ path, id: parsed.payload.id, source: parsed.payload.source, forkedFrom: parsed.payload.forked_from_id ?? null });
      }
      return records;
    }

    function hasExactAssistant(rollout: Rollout, text: string): boolean {
      return readSession(rollout.path, "codex").some(
        (message) => message.role === "assistant" && message.kind === "message" && message.text?.trim() === text,
      );
    }

    async function hasTmuxSession(name: string): Promise<boolean> {
      if (tmux === null) return false;
      return (await tmux("has-session", "-t", `=${name}`)).code === 0;
    }

    async function launchOwner(name: string, codexArgs: string[]): Promise<void> {
      if (tmux === null) throw new Error("tmux probe driver is unavailable");
      const result = await tmux(
        "new-session", "-d", "-s", name, "-c", workspace,
        "-e", `CODEX_HOME=${codexHome}`,
        "-e", `CCMUX_CONFIG=${configPath}`,
        "-e", `CCMUX_STATE_DIR=${stateDir}`,
        "-e", `CCMUX_CACHE_DIR=${cacheDir}`,
        resolvedCodexBin, "-s", "read-only", "-a", "never", "--no-alt-screen", ...codexArgs,
      );
      if (result.code !== 0) throw new Error(`tmux owner launch failed: ${name}`);
      await waitFor(`${name} startup screen`, async () => {
        if (tmux === null) return false;
        const captured = await tmux("capture-pane", "-p", "-t", `=${name}:0.0`, "-S", "-40");
        if (captured.code !== 0) return false;
        if (captured.stdout.includes("Do you trust the contents of this directory?")) {
          const approved = await tmux("send-keys", "-t", `=${name}:0.0`, "1", "Enter");
          if (approved.code !== 0) throw new Error(`failed to approve isolated workspace trust: ${name}`);
          return true;
        }
        return captured.stdout.trim() !== "";
      }, COMMAND_TIMEOUT_MS);
    }

    await launchOwner("source-owner", ["-C", workspace, "Reply exactly SOURCE_READY. Do not use tools."]);
    await waitFor("ordinary source TUI rollout", () => rollouts().length === 1, COMMAND_TIMEOUT_MS);
    const source = rollouts()[0];
    if (source === undefined || source.source !== "cli") throw new Error("source was not an ordinary CLI TUI thread");
    await waitFor("source turn", () => hasExactAssistant(source, "SOURCE_READY"), TURN_TIMEOUT_MS);
    if (!(await hasTmuxSession("source-owner"))) throw new Error("source owner exited unexpectedly");
    await Bun.sleep(500);
    const sourceHashBeforeFork = createHash("sha256").update(readFileSync(source.path)).digest("hex");

    appServer = startAppServer(codexBin, env);
    await appServer.initialize();
    let conflict = "";
    try {
      await appServer.request("thread/resume", { threadId: source.id });
    } catch (error) {
      conflict = error instanceof Error ? error.message : String(error);
    }
    if (!conflict.includes("already has an active writer")) throw new Error("external contender was not rejected");

    const heldAdopt = await boundedRun(["bun", cli, "adopt", "codex", source.id, "managed-held"], env, TURN_TIMEOUT_MS);
    if (heldAdopt.code === 0) throw new Error("ccmux adopted a thread whose writer was already held");
    if (loadSessions(machine).some((session) => session.name === "managed-held")) throw new Error("held adopt left a ready registry row");
    if (loadPendingSessions(machine).some((pending) => pending.session.name === "managed-held")) throw new Error("held adopt left a pending row");
    if (await hasTmuxSession("managed-held")) throw new Error("held adopt left a tmux pane");

    const ccmuxFork = await boundedRun(["bun", cli, "adopt", "codex", source.id, "managed-fork", "--fork"], env, TURN_TIMEOUT_MS);
    if (ccmuxFork.code !== 0) throw new Error(`ccmux native fork failed: ${ccmuxFork.stdout}${ccmuxFork.stderr}`);
    await waitFor("ccmux native fork rollout", () => rollouts().some((rollout) => rollout.forkedFrom === source.id), COMMAND_TIMEOUT_MS);
    const fork = rollouts().find((rollout) => rollout.forkedFrom === source.id);
    if (fork === undefined || fork.id === source.id) throw new Error("ccmux native fork did not create a distinct thread");
    const managedFork = loadSessions(machine).find((session) => session.name === "managed-fork");
    if (managedFork?.uuid !== fork.id || managedFork.agent !== "codex") throw new Error("ccmux fork promotion did not pin the provider UUID");
    const sourceOwnerAliveDuringFork = await hasTmuxSession("source-owner");
    if (!sourceOwnerAliveDuringFork) throw new Error("ccmux native fork displaced the source owner");
    await waitFor("managed fork ready for a follow-up turn", async () => {
      if (tmux === null) return false;
      const pane = await tmux("capture-pane", "-p", "-t", "=managed-fork:0.0", "-S", "-40");
      return pane.code === 0 && pane.stdout.includes("›");
    }, TURN_TIMEOUT_MS);
    await Bun.sleep(2_000);
    const historyTurn = await boundedRun(
      ["bun", cli, "send", "managed-fork", "Reply only with the exact all-caps token from the source assistant's immediately preceding answer. Do not use tools."],
      env,
      COMMAND_TIMEOUT_MS,
    );
    if (historyTurn.code !== 0) throw new Error(`ccmux fork history check failed to send: ${historyTurn.stdout}${historyTurn.stderr}`);
    await waitFor("fork inherited source history", () => hasExactAssistant(fork, "SOURCE_READY"), TURN_TIMEOUT_MS);
    await waitFor("managed fork ready after history check", async () => {
      if (tmux === null) return false;
      const pane = await tmux("capture-pane", "-p", "-t", "=managed-fork:0.0", "-S", "-40");
      return pane.code === 0 && pane.stdout.includes("›");
    }, TURN_TIMEOUT_MS);
    await Bun.sleep(1_000);
    const forkTurn = await boundedRun(
      ["bun", cli, "send", "managed-fork", "Reply exactly CCMUX_FORK_READY. Do not use tools."],
      env,
      COMMAND_TIMEOUT_MS,
    );
    if (forkTurn.code !== 0) throw new Error(`ccmux fork follow-up send failed: ${forkTurn.stdout}${forkTurn.stderr}`);
    await waitFor("fork-only assistant turn", () => hasExactAssistant(fork, "CCMUX_FORK_READY"), TURN_TIMEOUT_MS);
    if (hasExactAssistant(source, "CCMUX_FORK_READY")) throw new Error("fork-only turn leaked into the source rollout");
    const sourceHashAfterFork = createHash("sha256").update(readFileSync(source.path)).digest("hex");
    if (sourceHashAfterFork !== sourceHashBeforeFork) throw new Error("native fork mutated the source rollout");

    const killed = await tmux("kill-session", "-t", "=source-owner");
    if (killed.code !== 0) throw new Error("failed to stop source owner");
    await waitFor("source owner exit", async () => !(await hasTmuxSession("source-owner")), COMMAND_TIMEOUT_MS);
    await appServer.request("thread/resume", { threadId: source.id });
    const appServerHeldAdopt = await boundedRun(
      ["bun", cli, "adopt", "codex", source.id, "managed-appserver-held"],
      env,
      TURN_TIMEOUT_MS,
    );
    if (appServerHeldAdopt.code === 0) throw new Error("ccmux adopted a thread held by App Server");
    if (loadSessions(machine).some((session) => session.name === "managed-appserver-held")) {
      throw new Error("App Server conflict left a ready registry row");
    }
    if (loadPendingSessions(machine).some((pending) => pending.session.name === "managed-appserver-held")) {
      throw new Error("App Server conflict left a pending row");
    }
    if (await hasTmuxSession("managed-appserver-held")) throw new Error("App Server conflict left a tmux pane");
    await appServer.terminate();
    appServer = null;
    const coldAdopt = await boundedRun(["bun", cli, "adopt", "codex", source.id, "managed-adopt"], env, TURN_TIMEOUT_MS);
    if (coldAdopt.code !== 0) throw new Error(`ccmux cold adopt failed: ${coldAdopt.stdout}${coldAdopt.stderr}`);
    const managedAdopt = loadSessions(machine).find((session) => session.name === "managed-adopt");
    if (managedAdopt?.uuid !== source.id || managedAdopt.agent !== "codex") throw new Error("cold adopt did not preserve the source UUID");
    if (!(await hasTmuxSession("managed-adopt"))) throw new Error("cold adopted session has no managed pane");

    const version = await boundedRun([codexBin, "--version"], env);
    if (version.code !== 0) throw new Error("codex --version failed");
    output = {
      codexVersion: version.stdout.trim(),
      sourceOrdinaryTui: true,
      appServerConflictWhileHeld: true,
      ccmuxHeldAdoptRolledBack: true,
      ccmuxAppServerHeldAdoptRolledBack: true,
      ccmuxNativeForkPromotedDistinctThread: true,
      ccmuxForkInheritedHistory: true,
      ccmuxForkTurnStayedInFork: true,
      forkMetadataPinnedToSource: true,
      sourceOwnerAliveDuringFork: true,
      sourceUnchangedByFork: true,
      ccmuxColdAdoptPreservedUuid: true,
      filesKept: process.env.CCMUX_PROBE_KEEP === "1",
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (appServer !== null) {
    try { await appServer.terminate(); } catch (error) { cleanupErrors.push(error); }
  }
  if (tmux !== null) {
    for (const name of allSessions) {
      try { await tmux("kill-session", "-t", `=${name}`); } catch (error) { cleanupErrors.push(error); }
    }
    try { await tmux("kill-server"); } catch (error) { cleanupErrors.push(error); }
    try {
      await waitFor("isolated tmux cleanup", async () => {
        for (const name of allSessions) if ((await tmux?.("has-session", "-t", `=${name}`))?.code === 0) return false;
        return true;
      }, EXIT_TIMEOUT_MS);
    } catch (error) { cleanupErrors.push(error); }
  }
  if (root !== null) {
    try {
      if (process.env.CCMUX_PROBE_KEEP !== "1") rmSync(root, { recursive: true, force: true });
      else if (!existsSync(root)) throw new Error("KEEP requested but probe files are missing");
    } catch (error) { cleanupErrors.push(error); }
  }
  if (primaryError !== null && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "ownership probe and cleanup failed");
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "ownership probe cleanup failed");
  if (output === null) throw new Error("ownership probe produced no result");
  console.log(JSON.stringify(output));
}

await main();

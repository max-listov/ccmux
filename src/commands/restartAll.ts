import { existsSync, readFileSync, rmSync } from "node:fs";
import type { MachineConfig, Session } from "../types.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, updateSessionUuid } from "../config/sessions.ts";
import { forkedUuid } from "../agent/index.ts";
import { liveWriters } from "../agent/claude/writers.ts";
import { killSession } from "../tmux/tmux.ts";
import { STATE_DIR } from "../config/paths.ts";
import { atomicWrite } from "../util/atomic.ts";
import { runDetached } from "../util/spawn.ts";
import { SELF_ARGV } from "../env.ts";
import { log } from "../util/log.ts";
import { startSession } from "./lifecycle.ts";

/**
 * `ccmux restart --all` — bounce the WHOLE fleet on this machine with one command, so a changed
 * global rule set / MCP config / ccmux release lands everywhere without pressing `r` N times.
 *
 * THE INVARIANT: at most ONE session is down at any instant. We kill a session and start it again
 * before touching the next one. That matters for two independent reasons:
 *   - tmux terminates its server when the LAST session dies (`exit-empty on` by default) — that
 *     drops attached clients and resets server-global options. Never emptying the server avoids it.
 *   - the daemon's heal tick would otherwise see a fleet-wide outage and start everything at once.
 * This is why the sweep does NOT reuse `cmdRestart`: that call awaits only the kill and detaches the
 * relaunch, so looping over it degenerates into "kill all, then start all" — precisely the shape the
 * invariant forbids.
 */

const SWEEP_LOCK = `${STATE_DIR}/restart-all.lock`;
const WRITER_GATE_MS = 5_000; // cap on waiting for the old agent process to actually be gone
const WRITER_POLL_MS = 250;

export interface RestartAllDeps {
  sessions: () => Session[];
  /** This ccmux's own session name (CCMUX_SESSION), or undefined when run outside a managed pane. */
  self: string | undefined;
  /** Re-pin the registry if the conversation forked to a new uuid; returns the current session. */
  followFork: (s: Session) => Promise<Session>;
  kill: (name: string) => Promise<void>;
  /** Wait until no CLI process is still driving this uuid (so the relaunch can't become a second writer). */
  writersGone: (uuid: string) => Promise<void>;
  start: (name: string, dir: string) => Promise<void>;
  onProgress?: (done: number, total: number, name: string) => void;
}

/**
 * The sweep itself — pure over injected deps so it's unit-testable without tmux or a registry.
 * Order: archived skipped; the CALLING session goes LAST (its pane dies and comes back, so doing it
 * first would blank the operator's own window for the whole sweep); every session is killed and
 * started before the next one is touched.
 */
export async function restartAllOnce(deps: RestartAllDeps): Promise<string[]> {
  const targets = deps.sessions().filter((s) => !s.archived);
  // self last — everything else keeps registry order
  const ordered = [...targets.filter((s) => s.name !== deps.self), ...targets.filter((s) => s.name === deps.self)];
  const done: string[] = [];
  for (const s of ordered) {
    const cur = await deps.followFork(s); // resume where the conversation actually lives now
    await deps.kill(cur.name);
    await deps.writersGone(cur.uuid); // the old agent is really gone → no two-writer fork
    await deps.start(cur.name, cur.dir);
    done.push(cur.name);
    deps.onProgress?.(done.length, ordered.length, cur.name);
  }
  return done;
}

/** Poll until no `cli` writer drives this uuid (the pane process we just killed), capped. */
async function waitWritersGone(uuid: string, capMs = WRITER_GATE_MS): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    try {
      const writers = await liveWriters(uuid);
      if (!writers.some((w) => w.kind === "cli")) return;
    } catch {
      return; // can't tell → don't stall the sweep
    }
    await Bun.sleep(WRITER_POLL_MS);
  }
}

/** Single-flight: a stale lock (dead pid) is ignored, a live one refuses the sweep. */
function sweepRunning(): boolean {
  try {
    if (!existsSync(SWEEP_LOCK)) return false;
    const pid = Number.parseInt(readFileSync(SWEEP_LOCK, "utf8").trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0); // throws when the pid is gone
    return true;
  } catch {
    return false; // no lock, unreadable, or a dead pid → free to run
  }
}

/** The public entry: validate, then hand the sweep to a DETACHED worker and return immediately. */
export async function cmdRestartAll(args: string[]): Promise<number> {
  if (args.includes("--then")) {
    console.error("restart --all: --then is not supported (that would ping every session); use ccmux msg");
    return 1;
  }
  if (args.some((a) => !a.startsWith("--"))) {
    console.error("restart --all takes no session name — it restarts every session on this machine");
    return 1;
  }
  if (sweepRunning()) {
    console.error("restart --all: a sweep is already running");
    return 1;
  }
  const m = loadMachineConfig();
  const targets = loadSessions(m).filter((s) => !s.archived);
  if (targets.length === 0) {
    console.log("no sessions to restart");
    return 0;
  }
  // Detached: the sweep must survive killing the very session it was launched from (an agent can run
  // `ccmux restart --all` from inside a managed pane), and must not block the caller/TUI.
  runDetached([...SELF_ARGV, "_restart-all-worker"]);
  console.log(`restarting ${targets.length} session${targets.length === 1 ? "" : "s"}, one at a time — watch: ccmux list`);
  return 0;
}

/** Hidden: the detached sweep driver. */
export async function cmdRestartAllWorker(): Promise<number> {
  if (sweepRunning()) return 0;
  await atomicWrite(SWEEP_LOCK, `${process.pid}\n`);
  const m: MachineConfig = loadMachineConfig();
  const self = process.env.CCMUX_SESSION;
  log.info({ msg: "restart --all: sweep started", self: self ?? null });
  try {
    const done = await restartAllOnce({
      sessions: () => loadSessions(m),
      self,
      followFork: async (s) => {
        const next = forkedUuid(s, m, loadSessions(m));
        if (next === null) return s;
        log.info({ msg: "restart --all: conversation moved — re-pinning", name: s.name, from: s.uuid, to: next });
        await updateSessionUuid(m, s.name, next);
        return { ...s, uuid: next };
      },
      kill: async (name) => {
        await killSession(m, name);
      },
      writersGone: (uuid) => waitWritersGone(uuid),
      start: (name, dir) => startSession(m, name, dir),
      onProgress: (i, total, name) => log.info({ msg: "restart --all: session restarted", name, i, total }),
    });
    log.info({ msg: "restart --all: sweep finished", count: done.length });
  } catch (e) {
    log.error({ msg: "restart --all: sweep failed", err: String(e) });
  } finally {
    try {
      rmSync(SWEEP_LOCK, { force: true });
    } catch {
      // best-effort
    }
  }
  return 0;
}

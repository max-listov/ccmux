import { existsSync, readFileSync, rmSync } from "node:fs";
import type { MachineConfig, Session } from "../types.ts";
import { loadMachineConfig } from "../config/machine.ts";
import { findSession, loadSessions, updateSessionUuid } from "../config/sessions.ts";
import { forkedUuid } from "../agent/index.ts";
import { killSession, listSessionNames } from "../tmux/tmux.ts";
import { STATE_DIR } from "../config/paths.ts";
import { atomicWrite } from "../util/atomic.ts";
import { runDetached } from "../util/spawn.ts";
import { SELF_ARGV } from "../env.ts";
import { log } from "../util/log.ts";
import { startSession } from "./lifecycle.ts";
import { clearLifecycleBlock } from "../config/lifecycleBlocks.ts";
import { appendMessage } from "../chat/store.ts";
import { buildEnvelope } from "../chat/compose.ts";
import { cliPrincipal, managedPeer, ownerTarget, targetLabel } from "../chat/identity.ts";
import { chatEnabledFor } from "../config/chat.ts";
import { providerFor } from "../agent/index.ts";

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

/**
 * The sweep is the ONE command whose caller is dead when it finishes.
 *
 * Every other verb reports to whoever ran it. This one restarts the calling session last — by
 * design, so the operator's own pane is not blank for the whole sweep — which means the result has
 * physically nobody to return to. Measured: an agent swept the fleet, its own session came back, and
 * it then sat silent until a human asked "well?", because the outcome had died with the process that
 * asked for it.
 *
 * The old answer to this was `restart --then "<note>"`, and it is NOT coming back: it was removed in
 * 0.12.0 because a note carried on a lifecycle flag has no sender, no reply address and no entry in
 * the ledger. So the sweep says its piece the way everything else does — a recorded envelope, from
 * this machine's CLI principal, which is what the sweep honestly is. Delivery then rides the normal
 * chat path, including its wait for a pane that is actually drawn, so the report cannot land in a
 * half-painted interface.
 */
export function sweepSummary(machine: string, done: readonly string[], failure: string | null, self: string | undefined): string {
  const head = failure === null
    ? `ccmux restart --all finished on ${machine}: ${done.length} session(s) restarted`
    : `ccmux restart --all FAILED on ${machine} after ${done.length} session(s): ${failure}`;
  const names = done.length === 0 ? "" : ` — ${done.join(", ")}`;
  // Named explicitly, because the alternative is an agent wondering why a report arrived for
  // something it does not remember starting: its own restart is why the answer came this way.
  const why = self !== undefined && done.includes(self)
    ? ` This session was restarted last by that sweep, which is why the result arrives as a message rather than as the command's output.`
    : "";
  return `${head}${names}.${why}`;
}

/**
 * Deliver that summary. To the calling session when it exists, is running and can receive chat;
 * otherwise to the owner — and a caller that did NOT come back is called out by name rather than
 * quietly dropped along with its report, since "the session that ran the sweep is gone" is the one
 * outcome nobody would otherwise notice.
 */
export interface SweepReport {
  /** `caller` = the session that started the sweep; `owner` = the human, out of band. */
  recipient: "caller" | "owner";
  body: string;
}

/** Pure: facts about the caller → who hears about the sweep, and in what words. Kept separate from
 *  the delivery so the decision is testable without a tmux server or a registry. */
export function sweepReport(
  machine: string,
  self: string | undefined,
  done: readonly string[],
  failure: string | null,
  caller: { known: boolean; running: boolean; canChat: boolean } | null,
): SweepReport {
  const body = sweepSummary(machine, done, failure, self);
  // No calling session at all — a shell, or a scheduler. There is nobody to wake, so the owner is
  // the honest recipient rather than a dropped report.
  if (self === undefined || caller === null) return { recipient: "owner", body };
  if (caller.known && caller.running && caller.canChat) return { recipient: "caller", body };
  const why = !caller.known
    ? "it is no longer in the registry"
    : !caller.running
      ? "it did NOT come back up after its restart"
      : "it cannot receive chat";
  // Said out loud rather than swallowed: a caller that never came back is the one outcome of a sweep
  // that nobody would otherwise notice, because the thing that would have noticed is what is missing.
  return { recipient: "owner", body: `${body} The session that started it ('${self}') could not be told: ${why}.` };
}

export async function reportSweep(m: MachineConfig, self: string | undefined, done: readonly string[], failure: string | null): Promise<void> {
  const session = self === undefined ? undefined : findSession(loadSessions(m), self);
  const running = await listSessionNames(m);
  const caller = self === undefined
    ? null
    : {
        known: session !== undefined,
        running: session !== undefined && running.has(session.name),
        canChat: session !== undefined && chatEnabledFor(session, m) && providerFor(session).inspectChatPane !== undefined,
      };
  const report = sweepReport(m.rcPrefix, self, done, failure, caller);
  const to = report.recipient === "caller" && session !== undefined ? managedPeer(m.rcPrefix, session) : ownerTarget();
  appendMessage(m, buildEnvelope(cliPrincipal(m.rcPrefix), to, report.body));
  log.info({ msg: "restart --all: result reported", to: targetLabel(to) });
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
  let done: string[] = [];
  let failure: string | null = null;
  try {
    done = await restartAllOnce({
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
      // killSession already waits for the managed pane process group. External writer ownership is
      // intentionally outside this managed lifecycle task.
      writersGone: async () => {},
      start: (name, dir) => {
        clearLifecycleBlock(m, name);
        return startSession(m, name, dir);
      },
      onProgress: (i, total, name) => log.info({ msg: "restart --all: session restarted", name, i, total }),
    });
    log.info({ msg: "restart --all: sweep finished", count: done.length });
  } catch (e) {
    failure = String(e);
    log.error({ msg: "restart --all: sweep failed", err: failure });
  } finally {
    try {
      rmSync(SWEEP_LOCK, { force: true });
    } catch {
      // best-effort
    }
  }
  // AFTER the lock is released: the report is delivered by the daemon on its own cadence, and a
  // sweep that is finished must not look like one still running while it composes a sentence.
  try {
    await reportSweep(m, self, done, failure);
  } catch (e) {
    // The sweep itself succeeded; failing to announce it must not turn into a failure exit.
    log.error({ msg: "restart --all: could not record the report", err: String(e) });
  }
  return 0;
}

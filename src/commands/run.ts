import { existsSync } from "node:fs";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { providerFor } from "../agent/index.ts";
import { promptInvocation } from "../env.ts";
import { log } from "../util/log.ts";

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const FAST_FAIL_MS = 5_000; // exited sooner than this == suspicious
const FAST_FAILS_BEFORE_FORK = 3;

/**
 * The in-session conversation-level supervisor. ccmux (this loop) — NOT the agent — is
 * the tmux pane's foreground process, so an agent crash just relaunches here. Fully
 * provider-agnostic: launch argv/env, history location and resume are all decided by
 * the session's AgentProvider.
 *
 *  - P0-1: the spawn is caught INSIDE the loop, and cwd is passed to Bun.spawn (no
 *    process-global chdir). A deleted dir fails the spawn, not the supervisor.
 *  - P0-2: exponential backoff (2s→60s), never a 2s hot-loop; after K fast failures
 *    try a provider recovery (Claude `--fork-session`) once to unwedge.
 *  - P0-3: "fast failure" is judged by ELAPSED TIME, not exit code — the agent may
 *    exit 0 even on a resume error.
 */
export async function cmdRun(name: string | undefined): Promise<number> {
  if (!name) {
    log.error({ msg: "_run requires a session name" });
    return 1;
  }
  const m = loadMachineConfig();
  const s = findSession(loadSessions(m), name);
  if (!s) {
    log.error({ msg: "unknown session", name });
    return 1;
  }
  const provider = providerFor(s);
  const env = provider.launchEnv(m, s.name);
  let backoff = MIN_BACKOFF_MS;
  let fastFails = 0;
  let forkNext = false;

  for (;;) {
    const hf = provider.historyFile(s, m);
    const present = hf !== null && existsSync(hf); // re-checked every loop
    // The invocation TAUGHT to the agent (bare `ccmux` shim when installed) — NOT the
    // absolute self re-exec; those are different concerns (see env.ts). Re-evaluated each
    // loop so a shim installed after boot is picked up on the next relaunch.
    const argv = provider.buildArgv(s, m, promptInvocation(), present);
    if (forkNext) {
      if (provider.id === "claude") argv.push("--fork-session"); // wedge recovery (Claude only)
      forkNext = false;
    }
    const startedAt = Date.now();
    let crashed = false;
    try {
      const proc = Bun.spawn(argv, {
        cwd: s.dir,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env,
      });
      await proc.exited;
    } catch (e) {
      crashed = true;
      log.error({ msg: "agent spawn failed", name, agent: provider.id, err: String(e) });
    }

    const elapsed = Date.now() - startedAt;
    if (crashed || elapsed < FAST_FAIL_MS) {
      fastFails += 1;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      log.warn({ msg: "agent exited fast", name, agent: provider.id, elapsedMs: elapsed, fastFails, backoffMs: backoff });
      if (fastFails >= FAST_FAILS_BEFORE_FORK) {
        forkNext = true;
        fastFails = 0;
        log.warn({ msg: "attempting recovery relaunch", name, agent: provider.id });
      }
    } else {
      backoff = MIN_BACKOFF_MS;
      fastFails = 0;
    }
    await Bun.sleep(backoff);
  }
}

import { existsSync } from "node:fs";
import { loadMachineConfig } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { providerFor, type AgentProvider } from "../agent/index.ts";
import { capturePane, sendKeysNamed } from "../tmux/tmux.ts";
import type { MachineConfig, Session } from "../types.ts";
import { promptInvocation } from "../env.ts";
import { log } from "../util/log.ts";

const MIN_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const FAST_FAIL_MS = 5_000; // exited sooner than this == suspicious
const FAST_FAILS_BEFORE_FORK = 3;

const PICKER_WATCH_MS = 30_000; // give up watching for the resume picker after this
const PICKER_POLL_MS = 1_000;

/**
 * Dismiss Claude's BLOCKING "Resume from summary?" picker on an unattended resume, so a
 * daemon-healed reboot doesn't strand a big session at a menu (typed input would land on the
 * menu, not the conversation). One-shot + bounded: the first time the picker is seen we send
 * the policy choice (the option NUMBER), then confirm with Enter ONLY if the number key didn't
 * already select-and-confirm (re-check avoids a stray Enter submitting an empty turn). A session
 * that never shows a picker just costs a few cheap captures until PICKER_WATCH_MS. Provider-
 * agnostic: a no-op when the provider has no picker or the policy is "off". Not awaited by the
 * supervisor — it self-terminates while the loop blocks on the agent's exit.
 */
async function settleResumePicker(m: MachineConfig, s: Session, provider: AgentProvider): Promise<void> {
  const answer = provider.resumePickerAnswer;
  if (!answer) return;
  const deadline = Date.now() + PICKER_WATCH_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(PICKER_POLL_MS);
    let key: string | null = null;
    try {
      key = answer(await capturePane(m, s.name, 40), m);
    } catch {
      continue; // pane not capturable yet (still spawning) — retry
    }
    if (key === null) continue;
    await sendKeysNamed(m, s.name, key);
    await Bun.sleep(500); // let the menu register the selection
    let stillUp = false;
    try {
      stillUp = answer(await capturePane(m, s.name, 40), m) !== null;
    } catch {
      stillUp = false;
    }
    if (stillUp) await sendKeysNamed(m, s.name, "Enter"); // number only moved the cursor → confirm
    log.info({ msg: "answered resume picker", name: s.name, agent: provider.id, choice: m.resumePicker });
    return;
  }
}

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
      // Only a resume (history present) can hit the "Resume from summary?" picker; a fresh
      // session never shows it. Fire-and-forget — the watcher self-terminates and bounds itself.
      if (present) void settleResumePicker(m, s, provider);
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

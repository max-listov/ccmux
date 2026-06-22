import type { MachineConfig, Session } from "../types.ts";
import { loadMachineConfig, rcName } from "../config/machine.ts";
import { loadSessions, findSession } from "../config/sessions.ts";
import { hasSession, newSession, killSession, setOption, setPaneOption, capturePane } from "../tmux/tmux.ts";
import { runDetached } from "../util/spawn.ts";
import { SELF_ARGV } from "../env.ts";
import { providerFor } from "../agent/index.ts";
import { log } from "../util/log.ts";
import { refusesSelf } from "./guard.ts";
import { cmdSend } from "./send.ts";

/** Create the tmux session running ccmux's own `_run` loop. Idempotent. */
export async function startSession(m: MachineConfig, name: string, dir: string): Promise<void> {
  if (await hasSession(m, name)) {
    console.log(`${name} already running`);
    return;
  }
  await newSession(m, name, dir, [...SELF_ARGV, "_run", name]);
  // lock the window/session name so claude's escape sequences can't rename it out
  // from under the =NAME exact-match invariant.
  await setOption(m, name, "automatic-rename", "off");
  await setOption(m, name, "allow-rename", "off");
  await setOption(m, name, "mouse", "on");
  await setOption(m, name, "history-limit", "50000");
  // Claude-Code-in-tmux nicety, kept PANE-local (never the shared tmux server's
  // globals): lets claude's notification/progress escape sequences pass through tmux
  // when you attach interactively. (focus-events / extended-keys / terminal-features
  // are server-global in tmux, so ccmux leaves them to your ~/.tmux.conf — see README.)
  await setPaneOption(m, name, "allow-passthrough", "on");
  log.info({ msg: "session started", name, rc: rcName(m, name), dir });
  console.log(`started ${name} (${rcName(m, name)})`);
}

export async function cmdStart(name: string | undefined): Promise<number> {
  if (!name) {
    console.log("usage: ccmux start <name>");
    return 1;
  }
  const m = loadMachineConfig();
  const s = findSession(loadSessions(m), name);
  if (!s) {
    console.log(`unknown session: ${name}`);
    return 1;
  }
  await startSession(m, name, s.dir);
  return 0;
}

export async function cmdStop(name: string | undefined, force = false): Promise<number> {
  if (!name) {
    console.log("usage: ccmux stop <name>");
    return 1;
  }
  if (refusesSelf("stop", name, force)) return 1;
  const m = loadMachineConfig();
  const ok = await killSession(m, name);
  if (ok) log.info({ msg: "session stopped", name });
  console.log(ok ? `stopped ${name}` : `${name} not running`);
  return 0;
}

export async function cmdRestart(args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    console.log('usage: ccmux restart <name> [--then "<note>"]');
    return 1;
  }
  const thenIdx = args.indexOf("--then");
  const note = thenIdx >= 0 ? (args[thenIdx + 1] ?? "") : "";
  const m = loadMachineConfig();
  await killSession(m, name);
  // Detached worker (own process group) survives killing the very session this runs in
  // — so a session can restart ITSELF and still get pinged back once it's ready.
  runDetached([...SELF_ARGV, "_restart-worker", name, note]);
  console.log(`restarting ${name}${note ? " (will ping when ready)" : ""}`);
  return 0;
}

/**
 * Wait until a (re)started session is ready for input: the agent banner is up (model
 * surfaced) AND it's idle (no working-spinner). Gated on real pane state via the
 * provider's scanPane, not a blind sleep, so a wake-note never lands in a half-loaded
 * pane. Two consecutive idle reads guard against a transient idle between load frames.
 */
async function waitReady(m: MachineConfig, s: Session, timeoutSec = 120): Promise<boolean> {
  const provider = providerFor(s);
  const deadline = Date.now() + timeoutSec * 1000;
  let ok = 0;
  while (Date.now() < deadline) {
    const scan = provider.scanPane(await capturePane(m, s.name, 30));
    if (scan.model !== null && scan.state === "idle") {
      ok += 1;
      if (ok >= 2) return true;
    } else {
      ok = 0;
    }
    await Bun.sleep(2000);
  }
  return false;
}

export async function cmdRestartWorker(name: string | undefined, note?: string): Promise<number> {
  if (!name) return 1;
  await Bun.sleep(1000); // let the kill settle before relaunch (race-safe)
  const m = loadMachineConfig();
  const s = findSession(loadSessions(m), name);
  if (!s) return 1;
  await startSession(m, name, s.dir);
  if (!note) return 0;
  if (!(await waitReady(m, s))) log.warn({ msg: "restart ready-wait timed out — sending note anyway", name });
  await cmdSend(name, [note]);
  log.info({ msg: "restart wake-note delivered", name });
  return 0;
}

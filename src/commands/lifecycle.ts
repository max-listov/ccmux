import { clearLifecycleBlock } from '../config/lifecycleBlocks.ts';
import { loadMachineConfig, rcName } from '../config/machine.ts';
import { findSession, loadSessions } from '../config/sessions.ts';
import { SELF_ARGV, SELF_ARGV_NO_ENV_FILE } from '../env.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import {
  hasSession,
  killSession,
  lingeringNotice,
  newSession,
  setOption,
  setPaneOption,
} from '../tmux/tmux.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import { runDetached } from '../util/spawn.ts';
import { refusesSelf } from './guard.ts';

/** Create the tmux session running ccmux's own `_run` loop. Idempotent. */
export async function startSession(m: MachineConfig, name: string, dir: string): Promise<void> {
  if (await hasSession(m, name)) {
    console.log(`${name} already running`);
    return;
  }
  await newSession(m, name, dir, [...SELF_ARGV_NO_ENV_FILE, '_run', name]);
  // lock the window/session name so claude's escape sequences can't rename it out
  // from under the =NAME exact-match invariant.
  await setOption(m, name, 'automatic-rename', 'off');
  await setOption(m, name, 'allow-rename', 'off');
  await setOption(m, name, 'mouse', 'on');
  await setOption(m, name, 'history-limit', '50000');
  // Claude-Code-in-tmux nicety, kept PANE-local (never the shared tmux server's
  // globals): lets claude's notification/progress escape sequences pass through tmux
  // when you attach interactively. (focus-events / extended-keys / terminal-features
  // are server-global in tmux, so ccmux leaves them to your ~/.tmux.conf — see README.)
  await setPaneOption(m, name, 'allow-passthrough', 'on');
  log.info({ msg: 'session started', name, rc: rcName(m, name), dir });
  console.log(`started ${name} (${rcName(m, name)})`);
}

/** Start the pending Codex bootstrap transaction. It is not a registry Session yet. */
export async function startBootstrapSession(
  m: MachineConfig,
  name: string,
  dir: string,
  generation: string,
): Promise<void> {
  if (await hasSession(m, name)) throw new Error(`${name} already running`);
  await newSession(m, name, dir, [...SELF_ARGV_NO_ENV_FILE, '_bootstrap', generation], {
    CCMUX_BOOTSTRAP_GENERATION: generation,
  });
  await setOption(m, name, 'automatic-rename', 'off');
  await setOption(m, name, 'allow-rename', 'off');
  await setOption(m, name, 'mouse', 'on');
  await setOption(m, name, 'history-limit', '50000');
  await setPaneOption(m, name, 'allow-passthrough', 'on');
}

export async function cmdStart(name: string | undefined): Promise<number> {
  if (!name) {
    console.log('usage: ccmux start <name>   ·   <machine>:<name> for another fleet machine');
    return 1;
  }
  const fwd = await forwardIfRemote(name, 'start', []);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  const s = findSession(loadSessions(m), name);
  if (!s) {
    console.log(`unknown session: ${name}`);
    return 1;
  }
  clearLifecycleBlock(m, name);
  await startSession(m, name, s.dir);
  return 0;
}

export async function cmdStop(name: string | undefined, force = false): Promise<number> {
  if (!name) {
    console.log('usage: ccmux stop <name>   ·   <machine>:<name> for another fleet machine');
    return 1;
  }
  const fwd = await forwardIfRemote(name, 'stop', force ? ['--force'] : []);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  if (refusesSelf('stop', name, force)) return 1;
  const { killed, lingering } = await killSession(m, name);
  if (killed) log.info({ msg: 'session stopped', name });
  console.log(killed ? `stopped ${name}` : `${name} not running`);
  // Said, not thrown: the session IS down, and a process group that outlived it is a fact an
  // operator can act on rather than a failure of the command that reports it.
  if (lingering !== null) console.log(lingeringNotice(lingering, name));
  return 0;
}

export async function cmdRestart(args: string[]): Promise<number> {
  const target = args[0];
  if (!target || args.length !== 1) {
    console.log('usage: ccmux restart <name>   ·   <machine>:<name> for another fleet machine');
    return 1;
  }
  const fwd = await forwardIfRemote(target, 'restart', [], { timeoutMs: 120_000 });
  if (fwd.done) return fwd.code;
  const { session: name, m } = fwd;
  // Verify the session EXISTS before killing anything. Without this a typo killed nothing, spawned a
  // detached worker that failed silently into /dev/null, and still returned 0 — "restarted!" while
  // nothing happened. Over ssh that lie becomes an initiator waiting forever for a task that was
  // never started; it is the same silent-miss class fleet addressing exists to remove.
  if (!findSession(loadSessions(m), name)) {
    console.error(`unknown session: ${name}`);
    return 1;
  }
  await killSession(m, name);
  // Detached worker (own process group) survives killing the very session this runs in
  // — so a session can restart ITSELF and still get pinged back once it's ready.
  runDetached([...SELF_ARGV, '_restart-worker', name]);
  console.log(`restarting ${name}`);
  return 0;
}

export async function cmdRestartWorker(name: string | undefined): Promise<number> {
  if (!name) return 1;
  await Bun.sleep(1000); // let the kill settle before relaunch (race-safe)
  const m = loadMachineConfig();
  const s = findSession(loadSessions(m), name);
  if (!s) return 1;
  clearLifecycleBlock(m, name);
  await startSession(m, name, s.dir);
  return 0;
}

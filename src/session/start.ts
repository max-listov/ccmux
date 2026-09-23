import { rcName } from '../config/machine.ts';
import { hasSession, newSession, setOption, setPaneOption } from '../tmux/tmux.ts';
import type { MachineConfig } from '../types.ts';
import { SELF_ARGV_NO_ENV_FILE } from '../util/env.ts';
import { log } from '../util/log.ts';

/** Create the tmux session running ccmux's own `_run` loop. Idempotent. */
export async function startSession(m: MachineConfig, name: string, dir: string): Promise<void> {
  if (await hasSession(m, name)) {
    console.log(`${name} already running`);
    return;
  }
  await newSession(m, name, dir, [...SELF_ARGV_NO_ENV_FILE, '_run', name]);
  await applySessionOptions(m, name);
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
  await applySessionOptions(m, name);
}

/**
 * The options every session ccmux creates is given — session-local, never the shared server's.
 *
 * Until the target was corrected (`sessionOptionTarget`) none of these reached any session: tmux
 * refused the bare `=NAME` form and the refusal was not checked.
 */
async function applySessionOptions(m: MachineConfig, name: string): Promise<void> {
  // Lock the window/session name so an agent's escape sequences can't rename it out from under the
  // =NAME exact-match invariant.
  await setOption(m, name, 'automatic-rename', 'off');
  await setOption(m, name, 'allow-rename', 'off');
  await setOption(m, name, 'mouse', 'on');
  await setOption(m, name, 'history-limit', '50000');
  // Claude-Code-in-tmux nicety, kept PANE-local (never the shared tmux server's globals): lets
  // claude's notification/progress escape sequences pass through tmux when you attach interactively.
  // (focus-events / extended-keys / terminal-features are server-global in tmux, so ccmux leaves them
  // to your ~/.tmux.conf — see README.)
  await setPaneOption(m, name, 'allow-passthrough', 'on');
}

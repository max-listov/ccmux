import { rcName } from '../config/machine.ts';
import { hasSession, newSession, setOption, setPaneOption } from '../tmux/tmux.ts';
import type { MachineConfig, PendingSession } from '../types.ts';
import { SELF_ARGV_NO_ENV_FILE } from '../util/env.ts';
import { log } from '../util/log.ts';

/** Create the tmux session running ccmux's own `_run` loop. Idempotent. */
export async function startSession(
  m: MachineConfig,
  name: string,
  dir: string,
  signal?: AbortSignal,
): Promise<void> {
  if (await hasSession(m, name, signal)) {
    console.log(`${name} already running`);
    return;
  }
  await newSession(m, name, dir, [...SELF_ARGV_NO_ENV_FILE, '_run', name], {}, signal);
  await applySessionOptions(m, name, signal);
  log.info({ msg: 'session started', name, rc: rcName(m, name), dir });
  console.log(`started ${name} (${rcName(m, name)})`);
}

/** Start the provider's pending transaction in its own tmux pane. */
export async function startBootstrapSession(
  m: MachineConfig,
  pending: PendingSession,
): Promise<void> {
  const { session, operation, generation } = pending;
  const { name, dir } = session;
  if (await hasSession(m, name)) throw new Error(`${name} already running`);
  const command = [...SELF_ARGV_NO_ENV_FILE, '_bootstrap', generation];
  // The SDK's standalone forkSession reads the owning process environment, before a query exists.
  if (session.agent === 'claude' && operation.kind === 'fork') {
    const profile = claudeExecutorProfile(m, session);
    command.unshift(
      '/usr/bin/env',
      ...(profile.claudeConfigDir === 'default'
        ? ['-u', 'CLAUDE_CONFIG_DIR']
        : [`CLAUDE_CONFIG_DIR=${profile.home}`]),
    );
  }
  await newSession(m, name, dir, command, {
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
async function applySessionOptions(
  m: MachineConfig,
  name: string,
  signal?: AbortSignal,
): Promise<void> {
  // Lock the window/session name so an agent's escape sequences can't rename it out from under the
  // =NAME exact-match invariant.
  await setOption(m, name, 'automatic-rename', 'off', signal);
  await setOption(m, name, 'allow-rename', 'off', signal);
  await setOption(m, name, 'mouse', 'on', signal);
  await setOption(m, name, 'history-limit', '50000', signal);
  // Claude-Code-in-tmux nicety, kept PANE-local (never the shared tmux server's globals): lets
  // claude's notification/progress escape sequences pass through tmux when you attach interactively.
  // (focus-events / extended-keys / terminal-features are server-global in tmux, so ccmux leaves them
  // to your ~/.tmux.conf — see README.)
  await setPaneOption(m, name, 'allow-passthrough', 'on', signal);
}

import { claudeExecutorProfile } from '../agent/claude/native/driver.ts';

import { verifyManagedLaunchRecipe } from '../config/launchRecipes.ts';
import { killSession } from '../tmux/tmux.ts';
import type { MachineConfig, Session } from '../types.ts';
import { SELF_ARGV } from '../util/env.ts';
import { log } from '../util/log.ts';
import { runDetached } from '../util/spawn.ts';
import { clearConversationSeen } from './conversationSeen.ts';
import { clearLifecycleBlock } from './lifecycleBlocks.ts';
import { removeSession } from './registry.ts';

/**
 * Stopping, restarting and removing a registered session — what the commands and the control
 * operations both do. The caller has already resolved the address to a session of this machine.
 */

/** What a stop found: whether anything was running, and a process group that outlived its session. */
export interface StopOutcome {
  stopped: boolean;
  /** A straggler's process group. The session IS down; this is a fact an operator can act on. */
  lingering: number | null;
}

export async function stopSession(m: MachineConfig, name: string): Promise<StopOutcome> {
  const { killed, lingering } = await killSession(m, name);
  if (killed) log.info({ msg: 'session stopped', name });
  return { stopped: killed, lingering };
}

/**
 * Stop a session and start it again under the same identity.
 *
 * A known impossible continuation is refused while the existing owner is still alive: this throws
 * before anything is killed. Launch revalidates; this preflight cannot authorize a later changed
 * configuration. The relaunch is a detached worker in its own process group, so it survives the kill
 * of the very session that asked — a session can restart itself and still be pinged back.
 */
export async function restartSession(m: MachineConfig, session: Session): Promise<void> {
  verifyManagedLaunchRecipe(m, session);
  await killSession(m, session.name);
  runDetached([...SELF_ARGV, '_restart-worker', session.name]);
}

/** Null when no session of that name is registered; the provider's history stays on disk. */
export async function removeRegisteredSession(
  m: MachineConfig,
  name: string,
): Promise<{ lingering: number | null } | null> {
  if (!(await removeSession(m, name))) return null;
  const { lingering } = await killSession(m, name);
  // A block outlives nothing: it describes a session that no longer exists. Leaving the file behind
  // means a later session of the same name inherits a verdict passed on someone else — harmless
  // today only because neither its generation nor its uuid could match.
  clearLifecycleBlock(m, name);
  clearConversationSeen(name);
  log.info({ msg: 'session removed', name });
  return { lingering };
}

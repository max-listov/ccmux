import { clearLifecycleBlock } from '../config/lifecycleBlocks.ts';
import { sessionsPath } from '../config/paths.ts';
import { removeSession } from '../config/sessions.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { killSession } from '../tmux/tmux.ts';
import { log } from '../util/log.ts';
import { refusesSelf } from './guard.ts';

export async function cmdRm(name: string | undefined, force = false): Promise<number> {
  if (!name) {
    console.log('usage: ccmux rm <name>   ·   <machine>:<name> for another fleet machine');
    return 1;
  }
  const fwd = await forwardIfRemote(name, 'rm', force ? ['--force'] : []);
  if (fwd.done) return fwd.code;
  const { session, m } = fwd;
  name = session;
  if (refusesSelf('rm', name, force)) return 1;
  const removed = await removeSession(m, name);
  if (!removed) {
    console.log(`'${name}' not in ${sessionsPath(m)}`);
    return 1;
  }
  await killSession(m, name);
  // A block outlives nothing: it describes a session that no longer exists. Leaving the file behind
  // means a later session of the same name inherits a verdict passed on someone else — harmless
  // today only because neither its generation nor its uuid could match.
  clearLifecycleBlock(m, name);
  log.info({ msg: 'session removed', name });
  console.log(`stopped ${name}`);
  console.log(`removed ${name} from ${sessionsPath(m)} (jsonl history kept on disk)`);
  return 0;
}

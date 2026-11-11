import { sessionsPath } from '../config/paths.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { removeRegisteredSession } from '../session/lifecycle.ts';
import { lingeringNotice } from '../tmux/tmux.ts';
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
  const removed = await removeRegisteredSession(m, name);
  if (removed === null) {
    console.log(`'${name}' not in ${sessionsPath(m)}`);
    return 1;
  }
  const { lingering } = removed;
  console.log(`stopped ${name}`);
  console.log(`removed ${name} from ${sessionsPath(m)} (jsonl history kept on disk)`);
  // Zero means removed, and it means only that. A straggler process group is reported on its own
  // line: the removal happened, so a caller that reads the code must not be told otherwise.
  if (lingering !== null) console.log(lingeringNotice(lingering, name));
  return 0;
}

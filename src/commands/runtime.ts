import { findSession, loadSessions } from '../config/sessions.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';

import { readManagedRuntimeStatus } from '../runtime/status.ts';

export async function cmdRuntime(name: string | undefined, args: string[]): Promise<number> {
  if (!name || args.some((arg) => arg !== '--json')) {
    console.error('usage: ccmux runtime <name|machine:name> [--json]');
    return 1;
  }
  const forward = await forwardIfRemote(name, 'runtime', args);
  if (forward.done) return forward.code;
  const s = findSession(loadSessions(forward.m), forward.session);
  if (s === undefined || !hasNativeRuntime(s)) {
    console.error('runtime: target is not a managed native session');
    return 1;
  }
  const read = readManagedRuntimeStatus(forward.m, s);
  if (args.includes('--json')) console.log(JSON.stringify(read));
  else
    console.log(
      `${forward.m.rcPrefix}:${s.name} ${read.snapshot?.state ?? read.status} · ${read.snapshot?.turn?.status ?? read.reason ?? 'no turn'}`,
    );
  return read.status === 'live' ? 0 : read.status === 'stale' ? 2 : 3;
}

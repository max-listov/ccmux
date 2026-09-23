import { forwardIfRemote } from '../fleet/forward.ts';
import { hasNativeRuntime } from '../runtime/modes.ts';
import { readManagedRuntimeStatus } from '../runtime/status.ts';
import { findSession, loadSessions } from '../session/registry.ts';
import { printLine } from '../util/stdout.ts';
import { parseFlags } from './flags.ts';

export async function cmdRuntime(args: string[]): Promise<number> {
  const flags = parseFlags('runtime', args, [1, 1]);
  const name = flags.positionals[0] as string;
  const forward = await forwardIfRemote(name, 'runtime', flags.flagArgs);
  if (forward.done) return forward.code;
  const s = findSession(loadSessions(forward.m), forward.session);
  if (s === undefined || !hasNativeRuntime(s)) {
    console.error('runtime: target is not a managed native session');
    return 1;
  }
  const read = readManagedRuntimeStatus(forward.m, s);
  if (flags.bool('json')) await printLine(JSON.stringify(read));
  else
    console.log(
      `${forward.m.rcPrefix}:${s.name} ${read.snapshot?.state ?? read.status} · ${read.snapshot?.turn?.status ?? read.reason ?? 'no turn'}`,
    );
  return read.status === 'live' ? 0 : read.status === 'stale' ? 2 : 3;
}

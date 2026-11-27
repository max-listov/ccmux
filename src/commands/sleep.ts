import { loadMachineConfig } from '../config/machine.ts';
import { routeFor } from '../fleet/address.ts';
import { forwardIfRemote } from '../fleet/forward.ts';
import { findSession, loadSessions, setSessionPinned } from '../session/registry.ts';
import {
  sleepSessionByName,
  wakeBeforeAttach,
  wakeSessionByName,
} from '../session/sleep/operations.ts';
import { attachTmux, cleanTerminalForAttach } from '../tmux/attach.ts';
import { hasSession } from '../tmux/tmux.ts';
import { parseFlags } from './flags.ts';
import { refusesSelf } from './guard.ts';

export async function cmdSleep(args: string[]): Promise<number> {
  const flags = parseFlags('sleep', args, [1, 1]);
  const target = flags.positionals[0] as string;
  const force = flags.bool('force');
  const fwd = await forwardIfRemote(target, 'sleep', force ? ['--force'] : [], {
    timeoutMs: 60_000,
  });
  if (fwd.done) return fwd.code;
  const { session: name, m } = fwd;
  if (refusesSelf('sleep', name, force)) return 1;
  try {
    const receipt = await sleepSessionByName(m, name, { forcePolicy: force });
    if (receipt.release === 'unsupported') {
      console.error(`cannot sleep ${name}: provider does not support sleep`);
      return 1;
    }
    console.log(receipt.duplicate ? `${name} is already sleeping` : `sleeping ${name}`);
    return 0;
  } catch (error) {
    console.error(
      `cannot sleep ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

export async function cmdWake(args: string[]): Promise<number> {
  const flags = parseFlags('wake', args, [1, 1]);
  const target = flags.positionals[0] as string;
  const fwd = await forwardIfRemote(target, 'wake', [], { timeoutMs: 60_000 });
  if (fwd.done) return fwd.code;
  const { session: name, m } = fwd;
  try {
    const { woke } = await wakeSessionByName(m, name);
    console.log(woke ? `woke ${name}` : `${name} is already awake`);
    return 0;
  } catch (error) {
    console.error(`cannot wake ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

export async function cmdPin(args: string[], pinned: boolean): Promise<number> {
  const verb = pinned ? 'pin' : 'unpin';
  const flags = parseFlags(verb, args, [1, 1]);
  const target = flags.positionals[0] as string;
  const fwd = await forwardIfRemote(target, verb, [], { timeoutMs: 30_000 });
  if (fwd.done) return fwd.code;
  const { session: name, m } = fwd;
  const session = findSession(loadSessions(m), name);
  if (!session) {
    console.error(`unknown session: ${name}`);
    return 1;
  }
  if (session.archived) {
    console.error(`cannot ${verb} ${name}: session is archived`);
    return 1;
  }
  await setSessionPinned(m, name, pinned);
  console.log(pinned ? `pinned ${name}` : `unpinned ${name}`);
  return 0;
}

export async function cmdAttach(args: string[]): Promise<number> {
  const flags = parseFlags('attach', args, [1, 1]);
  const target = flags.positionals[0] as string;
  const m = loadMachineConfig();
  const route = routeFor(target, m);
  if (route.kind === 'error') {
    console.error(route.message);
    return 1;
  }
  if (route.kind === 'remote') {
    console.error(`cannot attach to remote session '${target}': attach is local-only`);
    return 1;
  }
  const name = route.session;
  const session = findSession(loadSessions(m), name);
  if (!session) {
    console.error(`unknown session: ${name}`);
    return 1;
  }
  if (session.archived) {
    console.error(`cannot attach ${name}: session is archived`);
    return 1;
  }
  try {
    await wakeBeforeAttach(m, session, (line) => process.stderr.write(line));
  } catch (error) {
    console.error(`cannot wake ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!(await hasSession(m, name))) {
    console.error(`${name} has no live tmux session`);
    return 1;
  }
  cleanTerminalForAttach();
  return attachTmux(m, name);
}

import type { MachineConfig } from '../types.ts';
import { type Peer, remoteFailureCause, runPeer } from './transport.ts';

/**
 * One question to one other machine of the fleet, and what came of it.
 *
 * Every command that puts a fleet-wide answer together asks each machine the same way and has to
 * say the same three things apart: the machine was not reached, it was reached and did not answer
 * the question — usually because its ccmux is older than the command — or it answered. A machine
 * that did not answer is never read as one with nothing on it, so the reason travels with it.
 */

/** How another machine is run. A parameter so the fleet half is tested without a fleet. */
export type PeerRunner = typeof runPeer;

export type Asked<T> =
  | { machine: string; ok: true; answer: T }
  | { machine: string; ok: false; error: string };

export const NOT_IN_FLEET = 'not a machine of this fleet (see ccmux fleet)';

export async function askPeer<T>(
  m: MachineConfig,
  peer: Pick<Peer, 'machine' | 'alias'>,
  argv: string[],
  /** Reads the machine's stdout as the answer; a throw means it did not answer the question. */
  read: (stdout: string) => T,
  opts: {
    /** What was asked, for the sentence that says it was not answered: "search", "whois". */
    what: string;
    timeoutMs: number;
    connectTimeoutSeconds: number;
    runPeer?: PeerRunner | undefined;
    /** Withdraws the question: its process on the way to the other machine is ended. */
    signal?: AbortSignal | undefined;
  },
): Promise<Asked<T>> {
  const result = await (opts.runPeer ?? runPeer)(m, peer.machine, peer.alias, argv, {
    timeoutMs: opts.timeoutMs,
    connectTimeoutSeconds: opts.connectTimeoutSeconds,
    signal: opts.signal,
  });
  if (result.transportFailed)
    return {
      machine: peer.machine,
      ok: false,
      error: result.failureDetail ?? 'not reachable right now',
    };
  try {
    return { machine: peer.machine, ok: true, answer: read(result.stdout) };
  } catch {
    const cause = remoteFailureCause(result.stderr) ?? remoteFailureCause(result.stdout);
    return {
      machine: peer.machine,
      ok: false,
      error: `no ${opts.what} answer (exit ${result.code}): ${cause ?? 'nothing reported'} — is ccmux there older than this command?`,
    };
  }
}

/** The answer came, but names a machine other than the one asked: it is not that machine's. */
export const FROM_ANOTHER_MACHINE = 'the answer came from a different machine than the one asked';

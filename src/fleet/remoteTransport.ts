import { defaultWireSocketPath } from '@stitchwire/client';
import type { MachineConfig } from '../types.ts';
import { HOME } from '../util/home.ts';
import { callStitchwire } from './stitchwire.ts';
import type { RemoteResult } from './transport.ts';

/** The Stitchwire agent's socket this machine reaches its peers through. */
export function remoteSocketPath(m: MachineConfig): string {
  return m.remoteTransport?.agentSocket ?? defaultWireSocketPath({ homeDir: HOME });
}

export function remotePeers(m: MachineConfig): string[] {
  return (m.remoteTransport?.peers ?? []).filter((peer) => peer !== m.rcPrefix);
}

export function isRemotePeer(m: MachineConfig, machine: string): boolean {
  return remotePeers(m).includes(machine);
}

function failed(delivery: RemoteResult['delivery'], failureDetail: string): RemoteResult {
  return { code: 1, stdout: '', stderr: '', transportFailed: true, delivery, failureDetail };
}

/** Run one command on `machine` through the Stitchwire agent, keeping its delivery evidence. */
export async function runRemoteTransport(
  m: MachineConfig,
  machine: string,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal | undefined },
): Promise<RemoteResult> {
  if (opts?.signal?.aborted) return failed('not-sent', 'remote request cancelled before dispatch');
  return callStitchwire(
    remoteSocketPath(m),
    { to: machine, argv, stdin: opts?.stdin ?? null, timeoutMs: opts?.timeoutMs ?? 30_000 },
    opts?.signal,
  );
}

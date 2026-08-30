import { existsSync } from 'node:fs';
import { UnixClientTransportError } from 'stitchkit/server';
import { HOME } from '../env.ts';
import type { MachineConfig } from '../types.ts';
import { log } from '../util/log.ts';
import type { RemoteResult } from './transport.ts';
import { callWireDoor } from './wireDoor.ts';
import { readWireResult } from './wireProtocol.ts';

/** Local socket permissions are transport authority. Node IDs equal configured fleet prefixes;
 * callers never retry a failed Wire route through SSH or connect to the broker themselves. */
export function wireSocketPath(m: MachineConfig): string {
  return m.wire?.socket ?? `${HOME}/.local/state/stitchwire/agent.sock`;
}

export function wirePeers(m: MachineConfig): string[] {
  return (m.wire?.peers ?? []).filter((peer) => peer !== m.rcPrefix);
}

export function isWirePeer(m: MachineConfig, machine: string): boolean {
  return wirePeers(m).includes(machine);
}

function failed(delivery: RemoteResult['delivery'], failureDetail: string): RemoteResult {
  return { code: 1, stdout: '', stderr: '', transportFailed: true, delivery, failureDetail };
}

export async function runWire(
  m: MachineConfig,
  machine: string,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<RemoteResult> {
  if (opts?.signal?.aborted)
    return failed('not-sent', 'stitchwire request cancelled before dispatch');
  const socket = wireSocketPath(m);
  if (!existsSync(socket))
    return failed('not-sent', 'local stitchwire agent socket is unavailable');
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  try {
    const { response, body } = await callWireDoor({
      socket,
      body: JSON.stringify({ to: machine, argv, stdin: opts?.stdin ?? null, timeoutMs }),
      // This budget guards both headers and body, beyond the remote execution deadline.
      deadlineMs: timeoutMs + 10_000,
      ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (!response.ok) {
      log.debug({
        msg: 'wire door HTTP failure',
        status: response.status,
        body: body.slice(0, 4_096),
      });
      return failed('unknown', `stitchwire agent returned HTTP ${response.status}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return failed('unknown', 'stitchwire agent returned an unreadable result');
    }
    return readWireResult(value);
  } catch (error) {
    log.debug({ msg: 'wire door transport failed', err: String(error) });
    return failed(
      error instanceof UnixClientTransportError && error.delivery === 'not-dispatched'
        ? 'not-sent'
        : 'unknown',
      'stitchwire agent did not provide a complete result',
    );
  }
}

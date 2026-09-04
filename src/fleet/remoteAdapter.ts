import { existsSync } from 'node:fs';
import { createClient, createHttpClient } from 'stitchkit';
import { createUnixClientTransport, UnixClientTransportError } from 'stitchkit/server';
import { HOME } from '../env.ts';
import type { MachineConfig } from '../types.ts';
import { remoteTransportContract } from './remoteTransportContract.ts';
import type { RemoteResult } from './transport.ts';

export function remoteAdapterSocketPath(m: MachineConfig): string {
  return m.remoteTransport?.socket ?? `${HOME}/.local/state/ccmux/remote-adapter.sock`;
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

/** Calls one injected local adapter; provider protocol and credentials stay outside CCMux. */
export async function runRemoteAdapter(
  m: MachineConfig,
  machine: string,
  argv: string[],
  opts?: { stdin?: string; timeoutMs?: number; signal?: AbortSignal },
): Promise<RemoteResult> {
  if (opts?.signal?.aborted) return failed('not-sent', 'remote request cancelled before dispatch');
  const socket = remoteAdapterSocketPath(m);
  if (!existsSync(socket)) return failed('not-sent', 'local remote adapter is unavailable');
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const transport = createUnixClientTransport({
    socketPath: socket,
    maxConnections: 1,
    maxRequestBytes: 8 * 1024 * 1024 + 128 * 1024,
    maxResponseBytes: 52 * 1024 * 1024,
    maxHeaderBytes: 64 * 1024,
    headersTimeoutMs: timeoutMs + 10_000,
    maxRedirects: 0,
  });
  const http = createHttpClient({
    baseUrl: 'http://ccmux-remote.local',
    fetch: transport.fetch,
    timeout: timeoutMs + 10_000,
    retry: { limit: 0 },
  });
  const client = createClient(remoteTransportContract, http);
  try {
    const result = await client.call({
      to: machine,
      argv,
      stdin: opts?.stdin ?? null,
      timeoutMs,
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      transportFailed: result.transportFailed,
      delivery: result.delivery,
      ...(result.failureDetail === undefined ? {} : { failureDetail: result.failureDetail }),
      ...(result.permanent === undefined ? {} : { permanent: result.permanent }),
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    };
  } catch (error) {
    return failed(
      error instanceof UnixClientTransportError && error.delivery === 'not-dispatched'
        ? 'not-sent'
        : 'unknown',
      'remote adapter did not provide a complete result',
    );
  } finally {
    await transport.close();
  }
}

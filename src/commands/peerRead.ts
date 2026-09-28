import { existsSync, readFileSync } from 'node:fs';
import { createClient, createHttpClient } from 'stitchkit';
import { createUnixClientTransport, UnixClientTransportError } from 'stitchkit/server';
import { machineConfigPath, resolveMonitoringLocation } from '../config/location.ts';
import { controlSocket } from '../control/transport/socketPath.ts';
import { parseKnown } from '../fleet/peerDelta.ts';
import { peerReadContract } from '../fleet/peerReadContract.ts';
import { writeOut } from '../util/stdout.ts';

const USAGE =
  'usage: ccmux _peer-read list [--known <digests>] | chat-log -n <N> [--known <digests>]';

type Request =
  | { kind: 'list'; known: string[] }
  | { kind: 'chat-log'; limit: number; known: string[] };

function parse(args: readonly string[]): Request | null {
  const [kind, ...rest] = args;
  let known: string[] = [];
  let limit: number | null = null;
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined) return null;
    if (rest[i] === '--known') known = [...parseKnown(value)];
    else if (rest[i] === '-n' && /^\d+$/.test(value)) limit = Number(value);
    else return null;
  }
  if (kind === 'list' && limit === null) return { kind, known };
  if (kind === 'chat-log' && limit !== null) return { kind, limit, known };
  return null;
}

/**
 * `ccmux _peer-read` — what a fleet reader on another machine runs here. It relays: the daemon
 * builds the answer with its caches warm (`fleet/peerRead.ts`), and this process only asks over the
 * local control socket and prints. Nothing heavier than that client is loaded.
 *
 * A daemon that is not running is not a machine with nothing on it: then, and only when the request
 * never reached the daemon, the same answer is built here, cold, by the same functions.
 */
export async function cmdPeerRead(args: string[]): Promise<number> {
  const request = parse(args);
  if (request === null) {
    console.error(USAGE);
    return 2;
  }
  const path = machineConfigPath();
  const location = resolveMonitoringLocation(
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {},
  );
  const socket = controlSocket(location);
  let answer: Record<string, unknown> | null = null;
  if (existsSync(socket)) {
    const transport = createUnixClientTransport({
      socketPath: socket,
      maxConnections: 1,
      maxRequestBytes: 128 * 1024,
      maxResponseBytes: 16 * 1024 * 1024,
      maxHeaderBytes: 16 * 1024,
      headersTimeoutMs: 20_000,
      maxRedirects: 0,
    });
    const client = createClient(
      peerReadContract,
      createHttpClient({
        baseUrl: 'http://ccmux.local',
        fetch: transport.fetch,
        timeout: 20_000,
        retry: { limit: 0 },
      }),
    );
    try {
      answer =
        request.kind === 'list'
          ? await client.list({ known: request.known })
          : await client['chat-log']({ limit: request.limit, known: request.known });
    } catch (error) {
      if (!(error instanceof UnixClientTransportError && error.delivery === 'not-dispatched'))
        throw error;
    } finally {
      await transport.close();
    }
  }
  if (answer === null) {
    const { loadMachineConfig } = await import('../config/machine.ts');
    const { peerChatLogAnswer, peerListAnswer } = await import('../fleet/peerRead.ts');
    const m = loadMachineConfig();
    answer =
      request.kind === 'list'
        ? await peerListAnswer(m, request.known)
        : peerChatLogAnswer(m, request.limit, request.known);
  }
  await writeOut(`${JSON.stringify(answer)}\n`);
  return 0;
}

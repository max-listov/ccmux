import { join } from 'node:path';
import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { atomicWrite } from '../util/atomic.ts';
import { managedRuntimeRoot, readManagedRuntimeStatus } from './status.ts';
import { readPrivateJson } from './store.ts';

/** Enable, disable or reconnect one MCP server — durable between the caller and its owner. */
const RequestSchema = z
  .object({
    operationId: z.uuid(),
    generation: z.uuid(),
    server: z.string().min(1).max(128),
    action: z.enum(['enable', 'disable', 'reconnect']),
    phase: z.enum(['queued', 'complete', 'failed']),
    reason: z.string().max(512).nullable().default(null),
  })
  .strict();
export type RuntimeMcpRequest = z.infer<typeof RequestSchema>;

const path = (m: MachineConfig, s: Session) => join(managedRuntimeRoot(m, s), 'mcp-control.json');
export const readRuntimeMcpRequest = (m: MachineConfig, s: Session) =>
  readPrivateJson(path(m, s), RequestSchema);
export const writeRuntimeMcpRequest = (m: MachineConfig, s: Session, value: RuntimeMcpRequest) =>
  atomicWrite(path(m, s), JSON.stringify(RequestSchema.parse(value)), 0o600);

export async function requestRuntimeMcp(
  m: MachineConfig,
  s: Session,
  input: { operationId: string; server: string; action: 'enable' | 'disable' | 'reconnect' },
  signal: AbortSignal,
): Promise<{ server: string; status: string }> {
  const read = readManagedRuntimeStatus(m, s);
  if (read.status !== 'live' || !read.snapshot)
    throw new AppError('UNAVAILABLE', 'The native runtime is unavailable', 503);
  const servers = read.snapshot.mcpServers;
  if (servers === undefined)
    throw new AppError('UNSUPPORTED', 'This runtime does not report its MCP servers', 409);
  if (!servers.some((server) => server.name === input.server))
    // Refused against what the session actually has: naming a server it never loaded would ask the
    // runtime about something that does not exist and report the silence as success.
    throw new AppError('UNSUPPORTED', 'This session has no such MCP server', 409);
  const generation = read.snapshot.generation;
  const prior = readRuntimeMcpRequest(m, s);
  if (prior?.operationId !== input.operationId || prior.generation !== generation)
    await writeRuntimeMcpRequest(m, s, {
      operationId: input.operationId,
      generation,
      server: input.server,
      action: input.action,
      phase: 'queued',
      reason: null,
    });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const current = readRuntimeMcpRequest(m, s);
    if (current?.operationId !== input.operationId || current.generation !== generation)
      throw new AppError('IDENTITY_MISMATCH', 'The MCP request was replaced', 409);
    if (current.phase === 'failed')
      throw new AppError('UNAVAILABLE', current.reason ?? 'The runtime refused', 503);
    if (current.phase === 'complete') {
      // The status the session publishes afterwards, not the fact that a request completed: a
      // reconnect that the runtime accepted and that then failed is not a working server.
      const after = readManagedRuntimeStatus(m, s).snapshot?.mcpServers?.find(
        (server) => server.name === input.server,
      );
      return { server: input.server, status: after?.status ?? 'unknown' };
    }
    await Bun.sleep(100);
  }
  throw new AppError('UNAVAILABLE', 'The runtime did not answer the MCP request', 503);
}

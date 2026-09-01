import { AppError } from 'stitchkit';
import { z } from 'zod';
import type { MachineConfig, Session } from '../types.ts';
import { defineMailbox } from './mailbox.ts';

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

/**
 * A server list has to be fetched and a connection re-made, so this waits longer than a setting
 * and looks less often than a turn control: the answer arrives once, seconds in, not gradually.
 */
const mailbox = defineMailbox<RuntimeMcpRequest, { server: string; status: string }>({
  file: 'mcp-control',
  schema: RequestSchema,
  identity: (receipt) => receipt.operationId,
  pollMs: 100,
  deadlineMs: 30_000,
  precondition: (snapshot) => {
    if (snapshot.mcpServers === undefined)
      throw new AppError('UNSUPPORTED', 'This runtime does not report its MCP servers', 409);
  },
  settle: (receipt, snapshot) => {
    if (receipt.phase === 'failed')
      throw new AppError('UNAVAILABLE', receipt.reason ?? 'The runtime refused', 503);
    if (receipt.phase !== 'complete') return undefined;
    // The status the session publishes afterwards, not the fact that a request completed: a
    // reconnect that the runtime accepted and that then failed is not a working server.
    return {
      server: receipt.server,
      status:
        snapshot()?.mcpServers?.find((server) => server.name === receipt.server)?.status ??
        'unknown',
    };
  },
  mismatch: () => new AppError('IDENTITY_MISMATCH', 'The MCP request was replaced', 409),
});

export const readRuntimeMcpRequest = (m: MachineConfig, s: Session) => mailbox.read(m, s);
export const writeRuntimeMcpRequest = (m: MachineConfig, s: Session, value: RuntimeMcpRequest) =>
  mailbox.write(m, s, value);

export async function requestRuntimeMcp(
  m: MachineConfig,
  s: Session,
  input: { operationId: string; server: string; action: 'enable' | 'disable' | 'reconnect' },
  signal: AbortSignal,
): Promise<{ server: string; status: string }> {
  return mailbox.request(
    m,
    s,
    input.operationId,
    (generation, snapshot) => {
      // Refused against what the session actually has: naming a server it never loaded would ask
      // the runtime about something that does not exist and report the silence as success.
      if (!snapshot.mcpServers?.some((server) => server.name === input.server))
        throw new AppError('UNSUPPORTED', 'This session has no such MCP server', 409);
      return {
        operationId: input.operationId,
        generation,
        server: input.server,
        action: input.action,
        phase: 'queued',
        reason: null,
      };
    },
    signal,
  );
}

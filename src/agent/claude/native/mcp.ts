import type { NativeMcpServer } from '../../../runtime/projectionSchema.ts';

/**
 * What the runtime says about one MCP server, reduced to what an operator needs.
 *
 * `config` is not read at all: it carries the server's URL, headers and any token the host put
 * there, and a status projection is the wrong place for every one of them. A status this project
 * does not recognise becomes `unknown` rather than being dropped — a server missing from the list
 * reads as a server that does not exist.
 */
export interface ReportedMcpServer {
  name: string;
  status?: string | undefined;
  scope?: string | undefined;
  error?: string | undefined;
  tools?: readonly unknown[] | undefined;
}

const KNOWN = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'] as const;

export function nativeMcpServers(reported: readonly ReportedMcpServer[]): NativeMcpServer[] {
  return reported.slice(0, 64).map((server) => {
    const status = KNOWN.find((value) => value === server.status) ?? 'unknown';
    return {
      name: server.name.slice(0, 128),
      status,
      scope: server.scope?.slice(0, 64) ?? null,
      // A count only exists where the runtime listed tools; zero would claim a connected server
      // contributes nothing, which is a different statement from not having been told.
      tools: server.tools === undefined ? null : server.tools.length,
      error: server.error?.slice(0, 512) ?? null,
    };
  });
}

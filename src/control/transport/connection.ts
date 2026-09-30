import { existsSync, readFileSync } from 'node:fs';
import { createHttpClient } from 'stitchkit';
import { createUnixClientTransport } from 'stitchkit/server';
import { z } from 'zod';
import { machineConfigPath, resolveMonitoringLocation } from '../../config/location.ts';
import { EXTERNAL_MAX_BYTES } from '../../external/residentSchema.ts';
import { CONTROL_MAX_BYTES, CONTROL_MAX_READERS } from '../schema/core.ts';
import { controlSocket } from './socketPath.ts';

export const ControlClientOptionsSchema = z
  .object({
    socket: z.string().startsWith('/').optional(),
    session: z.string().min(1).optional(),
    credential: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1).max(65_000).default(65_000),
  })
  .strict()
  .refine(
    (value) => (value.session === undefined) === (value.credential === undefined),
    'Managed session and credential must be supplied together',
  );
export type ControlClientOptions = z.input<typeof ControlClientOptionsSchema>;

export function createControlConnection(options: ControlClientOptions) {
  const config = ControlClientOptionsSchema.parse(options);
  const headers: Record<string, string> = {};
  if (config.session && config.credential) {
    headers['x-ccmux-session'] = config.session;
    headers.authorization = `Bearer ${config.credential}`;
  }
  const path = machineConfigPath();
  const socket =
    config.socket ??
    controlSocket(
      resolveMonitoringLocation(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}),
    );
  const common = {
    socketPath: socket,
    maxRequestBytes: 64 * 1024,
    maxHeaderBytes: 16 * 1024,
    headersTimeoutMs: config.timeoutMs,
  };
  const unary = createUnixClientTransport({
    ...common,
    maxConnections: 128,
    maxResponseBytes: Math.max(CONTROL_MAX_BYTES, EXTERNAL_MAX_BYTES) + 1024,
  });
  let streaming: ReturnType<typeof createUnixClientTransport> | undefined;
  let stream: ReturnType<typeof createHttpClient> | undefined;
  return {
    http: createHttpClient({
      baseUrl: 'http://ccmux.local',
      fetch: unary.fetch,
      timeout: config.timeoutMs,
      retry: { limit: 0 },
      headers,
    }),
    get stream() {
      streaming ??= createUnixClientTransport({
        ...common,
        maxConnections: CONTROL_MAX_READERS,
        responseBodyMode: 'streaming',
      });
      stream ??= createHttpClient({
        baseUrl: 'http://ccmux.local',
        fetch: streaming.fetch,
        timeout: config.timeoutMs,
        retry: { limit: 0 },
        headers,
      });
      return stream;
    },
    close: async () => {
      await Promise.all([unary.close(), streaming?.close()]);
    },
  };
}

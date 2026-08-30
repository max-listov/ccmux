import { existsSync, readFileSync } from 'node:fs';
import { createClient, createHttpClient } from 'stitchkit';
import { implementRemote } from 'stitchkit/remote';
import { createUnixClientTransport } from 'stitchkit/server';
import { z } from 'zod';
import { machineConfigPath, resolveMonitoringLocation } from '../config/monitoring-location.ts';
import { EXTERNAL_MAX_BYTES } from '../external/resident-schema.ts';
import { controlContract, controlEventsContract } from './contract.ts';
import { controlSocket } from './path.ts';
import { CONTROL_MAX_BYTES, CONTROL_MAX_READERS } from './schema.ts';

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

function controlTransport(options: ControlClientOptions) {
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
  const streaming = createUnixClientTransport({
    ...common,
    maxConnections: CONTROL_MAX_READERS,
    responseBodyMode: 'streaming',
  });
  return {
    http: createHttpClient({
      baseUrl: 'http://ccmux.local',
      fetch: unary.fetch,
      timeout: config.timeoutMs,
      retry: { limit: 0 },
      headers,
    }),
    stream: createHttpClient({
      baseUrl: 'http://ccmux.local',
      fetch: streaming.fetch,
      timeout: config.timeoutMs,
      retry: { limit: 0 },
      headers,
    }),
    close: async () => {
      await Promise.all([unary.close(), streaming.close()]);
    },
  };
}

/** Connect again after a daemon/root change; watch always begins with a full baseline. */
export function createControlClient(options: ControlClientOptions = {}) {
  const transport = controlTransport(options);
  return {
    ...createClient(controlContract, transport.http),
    ...createClient(controlEventsContract, transport.stream),
    close: transport.close,
  };
}

/** CLI, MCP and agent adapters invoke this proxy; authorization stays in the daemon. */
export function createControlProxy(options: ControlClientOptions = {}) {
  const transport = controlTransport(options);
  return { ...implementRemote(controlContract, transport.http), close: transport.close };
}

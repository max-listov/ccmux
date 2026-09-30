import { createClient } from 'stitchkit';
import { implementRemote } from 'stitchkit/remote';
import { controlContract } from '../schema/contract.ts';
import { controlEventsContract } from '../schema/eventsContract.ts';
import { type ControlClientOptions, createControlConnection } from './connection.ts';

export { type ControlClientOptions, ControlClientOptionsSchema } from './connection.ts';

/** Connect again after a daemon/root change; watch always begins with a full baseline. */
export function createControlClient(options: ControlClientOptions = {}) {
  const transport = createControlConnection(options);
  return {
    ...createClient(controlContract, transport.http),
    ...createClient(controlEventsContract, transport.stream),
    close: transport.close,
  };
}

/** CLI, MCP and agent adapters invoke this proxy; authorization stays in the daemon. */
export function createControlProxy(options: ControlClientOptions = {}) {
  const transport = createControlConnection(options);
  return { ...implementRemote(controlContract, transport.http), close: transport.close };
}

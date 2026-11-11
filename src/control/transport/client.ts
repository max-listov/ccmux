import { createClient, readContractIdentity } from 'stitchkit';
import { implementRemote } from 'stitchkit/remote';
import { controlContract } from '../schema/contract.ts';
import { controlEventsContract } from '../schema/eventsContract.ts';
import { type ControlClientOptions, createControlConnection } from './connection.ts';

export { type ControlClientOptions, ControlClientOptionsSchema } from './connection.ts';

const CONTRACTS = [controlContract, controlEventsContract] as const;

/** Connect again after a daemon/root change; watch always begins with a full baseline. */
export function createControlClient(options: ControlClientOptions = {}) {
  const transport = createControlConnection(options);
  return {
    ...createClient(controlContract, transport.http),
    ...createClient(controlEventsContract, transport.stream),
    /**
     * This client's contract and the daemon's, side by side. The daemon updates itself on its own
     * clock, so a client is often newer than what it talks to: an operation absent from
     * `server.operations` is one that daemon does not have, a differing digest is a schema that
     * changed — a field missing there is "not sent by that release", not "no value". `server` is
     * undefined for a daemon too old to say.
     */
    identity: () => readContractIdentity(CONTRACTS, transport.http),
    close: transport.close,
  };
}

/** CLI, MCP and agent adapters invoke this proxy; authorization stays in the daemon. */
export function createControlProxy(options: ControlClientOptions = {}) {
  const transport = createControlConnection(options);
  return { ...implementRemote(controlContract, transport.http), close: transport.close };
}

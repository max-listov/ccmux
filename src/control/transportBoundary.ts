import { type ClientFetch, createClient } from 'stitchkit';
import { z } from 'zod';
import { RC_PREFIX_RE } from '../config/schema.ts';
import { controlContract } from './contract.ts';

/** Authenticated local transports may preserve the caller node at the CCMux Unix boundary. */
export const CCMUX_CONTROL_CALLER_HEADER = 'x-ccmux-caller';

export const ControlTransportCallerSchema = z.string().max(128).regex(RC_PREFIX_RE);

/** Compose the canonical contract with an injected delivery function. */
export function createInjectedControlClient(fetch: ClientFetch, timeoutMs = 30_000) {
  return createClient(controlContract, {
    baseUrl: 'http://ccmux.local',
    fetch,
    timeout: timeoutMs,
  });
}

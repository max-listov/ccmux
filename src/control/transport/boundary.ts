import { type ClientFetch, createClient } from 'stitchkit';
import { z } from 'zod';
import { RC_PREFIX_RE } from '../../chat/identitySchema.ts';
import { controlContract } from '../schema/contract.ts';

/** The node a declared-service caller is authenticated as: its machine's rc prefix. */
export const ControlTransportCallerSchema = z.string().max(128).regex(RC_PREFIX_RE);

/** Compose the canonical contract with an injected delivery function. */
export function createInjectedControlClient(fetch: ClientFetch, timeoutMs = 30_000) {
  return createClient(controlContract, {
    baseUrl: 'http://stitchmux.local',
    fetch,
    timeout: timeoutMs,
    retry: { limit: 0 },
  });
}

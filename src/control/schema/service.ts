import { controlContract } from './contract.ts';

/**
 * The declared service is the control contract: every operation, with the effect it declares in
 * `meta.service`. A transport projects its descriptor from `controlContract`, these effects and the
 * version of the package carrying them; it keeps no list of its own.
 */

type ControlEndpoints = typeof controlContract.endpoints;

/** Each operation's effect, as the operation declares it. */
export const controlServiceEffects = Object.fromEntries(
  Object.entries(controlContract.endpoints).map(([id, endpoint]) => [id, endpoint.meta.service]),
) as { readonly [K in keyof ControlEndpoints]: ControlEndpoints[K]['meta']['service'] };

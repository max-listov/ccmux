import { requireContractOperationEffects } from 'stitchkit/contract';
import { controlContract } from './contract.ts';

/**
 * The declared service is the control contract: every operation, with the effect it declares in
 * `effect`. A transport projects its descriptor from `controlContract`, these effects and the
 * version of the package carrying them; it keeps no list of its own.
 */

/** Each operation's effect, as the operation declares it. */
export const controlServiceEffects = requireContractOperationEffects(controlContract);

import { stableJson } from '../agent/launchInputs.ts';
import type { ApplicationPolicyEvidence, ApplicationPolicyMetadata } from './schema.ts';
import { ApplicationPolicyEvidenceSchema } from './schema.ts';

/** Only current native proof may upgrade a desired policy; stale/disconnected proofs cannot. */
export function projectApplicationPolicy(
  metadata: ApplicationPolicyMetadata,
  availability: string,
  native?: ApplicationPolicyEvidence,
): ApplicationPolicyEvidence {
  const matching = native !== undefined && stableJson(native.policy) === stableJson(metadata);
  const state = availability !== 'live' ? 'unavailable' : matching ? native.state : 'desired';
  return ApplicationPolicyEvidenceSchema.parse({ policy: metadata, state });
}

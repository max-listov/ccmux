import { stableJson } from '../agent/launchInputs.ts';
import type { ApplicationPolicyEvidence, ApplicationPolicyMetadata } from './schema.ts';
import { ApplicationPolicyEvidenceSchema } from './schema.ts';

/**
 * Only current native proof may upgrade a desired policy; stale/disconnected proofs cannot.
 *
 * An unavailable state travels with the reason it came from — the runtime's own when the runtime is
 * not live, the publisher's when it is — because the two are different repairs and the word
 * `unavailable` names neither. `availabilityReason` is what the runtime read already knows and used
 * to drop on the floor here.
 */
export function projectApplicationPolicy(
  metadata: ApplicationPolicyMetadata,
  availability: string,
  native?: ApplicationPolicyEvidence,
  availabilityReason?: string | null,
): ApplicationPolicyEvidence {
  const matching = native !== undefined && stableJson(native.policy) === stableJson(metadata);
  const state = availability !== 'live' ? 'unavailable' : matching ? native.state : 'desired';
  const reason =
    availability !== 'live'
      ? (availabilityReason ?? availability)
      : matching && native.state === 'unavailable'
        ? (native.reason ?? 'unavailable')
        : undefined;
  return ApplicationPolicyEvidenceSchema.parse({
    policy: metadata,
    state,
    ...(reason === undefined ? {} : { reason }),
  });
}

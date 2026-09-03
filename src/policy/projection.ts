import { stableJson } from '../agent/launchInputs.ts';
import { readLifecycleBlockForSession } from '../config/lifecycleBlocks.ts';
import type { MachineConfig, Session } from '../types.ts';
import { policyUnavailableReason } from './errors.ts';
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
/**
 * The policy code behind a session that is blocked, when that is why it is blocked.
 *
 * A policy refusal at admission kills the runtime before it publishes anything, so there is no
 * snapshot to carry the reason and the availability word — `unavailable` — is a tautology in the
 * one place a caller looks. What survives the dead worker is the lifecycle block's message, and the
 * code travels in it.
 */
export function blockedPolicyReason(m: MachineConfig, session: Session): string | undefined {
  try {
    return policyUnavailableReason(readLifecycleBlockForSession(m, session)?.error);
  } catch {
    // A reason is enrichment: a registry that cannot be read must not take the row with it.
    return undefined;
  }
}

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

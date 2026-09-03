import { AppError } from 'stitchkit';
import { log } from '../util/log.ts';

/**
 * Refuse, saying which condition failed.
 *
 * The reason is a bounded code, which is why it may leave this process: what public responses must
 * never carry is a native error or a path, and a code is neither. Without it the refusal names a
 * state and not one of the dozen conditions behind it, and the consumer — who cannot read this
 * tree — goes looking for the difference between `agents/` and `agent/` by hand.
 */
export function policyUnavailable(id: string, reason: string): never {
  log.error({ msg: 'application policy unavailable', policyId: id, reason });
  throw new AppError(
    'APPLICATION_POLICY_UNAVAILABLE',
    `Application policy is unavailable: ${reason}`,
    409,
  );
}

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
export const POLICY_UNAVAILABLE_MESSAGE = 'Application policy is unavailable';

export function policyUnavailable(id: string, reason: string): never {
  log.error({ msg: 'application policy unavailable', policyId: id, reason });
  throw new AppError(
    'APPLICATION_POLICY_UNAVAILABLE',
    `${POLICY_UNAVAILABLE_MESSAGE}: ${reason}`,
    409,
  );
}

/**
 * The code out of a refusal that crossed a process boundary as text.
 *
 * A runtime that cannot start because of its policy dies in its own worker, and what survives is
 * the lifecycle block's message — so the sentence is the channel, and this is its other end. Both
 * ends spell it once, here.
 */
export function policyUnavailableReason(message: string | null | undefined): string | undefined {
  if (!message?.startsWith(`${POLICY_UNAVAILABLE_MESSAGE}: `)) return undefined;
  const reason = message.slice(POLICY_UNAVAILABLE_MESSAGE.length + 2).trim();
  return /^[a-z][a-z0-9-]{0,63}$/.test(reason) ? reason : undefined;
}

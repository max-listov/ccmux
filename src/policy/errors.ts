import { AppError } from 'stitchkit';
import { log } from '../util/log.ts';

/** Only bounded reason codes enter owner logs; public responses never carry native errors or paths. */
export function policyUnavailable(id: string, reason: string): never {
  log.error({ msg: 'application policy unavailable', policyId: id, reason });
  throw new AppError('APPLICATION_POLICY_UNAVAILABLE', 'Application policy is unavailable', 409);
}

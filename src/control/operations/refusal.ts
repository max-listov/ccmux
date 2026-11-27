import { BoundedAdmissionRefusalError, BoundedOperationWaitError } from 'stitchkit/application';
import { refusals } from '../schema/refusals.ts';

/** A refusal by admission or a missed caller budget, as the control plane reports it. */
export function controlRefusal(error: unknown): never {
  if (error instanceof BoundedAdmissionRefusalError) {
    const draining = error.reason === 'not-accepting' || error.reason === 'upstream';
    throw draining
      ? refusals.errors.UNAVAILABLE({ message: 'Control is draining' })
      : refusals.errors.BUSY({ message: 'Control capacity reached' });
  }
  if (error instanceof BoundedOperationWaitError) {
    throw refusals.errors[error.reason === 'timed-out' ? 'TIMEOUT' : 'CANCELLED']({
      message: 'Control call did not finish within its caller budget',
    });
  }
  throw error;
}

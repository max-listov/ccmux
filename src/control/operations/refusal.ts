import { AppError } from 'stitchkit';
import { BoundedAdmissionRefusalError, BoundedOperationWaitError } from 'stitchkit/application';

/** A refusal by admission or a missed caller budget, as the control plane reports it. */
export function controlRefusal(error: unknown): never {
  if (error instanceof BoundedAdmissionRefusalError) {
    const draining = error.reason === 'not-accepting' || error.reason === 'upstream';
    throw new AppError(
      draining ? 'UNAVAILABLE' : 'BUSY',
      draining ? 'Control is draining' : 'Control capacity reached',
      draining ? 503 : 429,
    );
  }
  if (error instanceof BoundedOperationWaitError) {
    throw new AppError(
      error.reason === 'timed-out' ? 'TIMEOUT' : 'CANCELLED',
      'Control call did not finish within its caller budget',
      504,
    );
  }
  throw error;
}

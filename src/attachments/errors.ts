import type { AppError } from 'stitchkit';
import { refusals } from '../control/schema/refusals.ts';

export class AttachmentFault extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(reason, options);
  }
}

export function attachmentRefusal(): AppError {
  return refusals.errors.ATTACHMENT_UNAVAILABLE({ message: 'The image attachment is unavailable' });
}

export function assertAttachment(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new AttachmentFault(reason);
}

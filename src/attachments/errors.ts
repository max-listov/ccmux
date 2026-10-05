import { AppError } from 'stitchkit';

export class AttachmentFault extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(reason, options);
  }
}

export function attachmentRefusal(): AppError {
  return new AppError('ATTACHMENT_UNAVAILABLE', {
    message: 'The image attachment is unavailable',
    status: 409,
  });
}

export function assertAttachment(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new AttachmentFault(reason);
}

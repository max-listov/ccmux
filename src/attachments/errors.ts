import { AppError } from "stitchkit";

export class AttachmentFault extends Error {
  constructor(readonly reason: string) { super(reason); }
}

export function attachmentRefusal(): AppError {
  return new AppError("ATTACHMENT_UNAVAILABLE", "The image attachment is unavailable", 409);
}

export function assertAttachment(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new AttachmentFault(reason);
}

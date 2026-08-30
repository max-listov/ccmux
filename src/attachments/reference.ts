import { z } from 'zod';

export const ATTACHMENT_LIMITS = {
  imageBytes: 8 * 1024 * 1024,
  messageBytes: 16 * 1024 * 1024,
  imagesPerMessage: 4,
  chunkBytes: 24 * 1024,
  dimension: 8192,
  pixels: 16 * 1024 * 1024,
  uploadTtlMs: 30 * 60 * 1000,
  unretainedTtlMs: 24 * 60 * 60 * 1000,
  hostBytes: 256 * 1024 * 1024,
  hostUploads: 32,
  targetUploads: 8,
  records: 1024,
  pins: 4096,
  decodeDeadlineMs: 5000,
};

export const AttachmentMediaTypeSchema = z.enum(['image/png', 'image/jpeg']);
export const AttachmentDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const AttachmentReferenceSchema = z
  .object({
    id: z.uuid(),
    digest: AttachmentDigestSchema,
    mediaType: AttachmentMediaTypeSchema,
    bytes: z.number().int().positive().max(ATTACHMENT_LIMITS.imageBytes),
    width: z.number().int().positive().max(ATTACHMENT_LIMITS.dimension),
    height: z.number().int().positive().max(ATTACHMENT_LIMITS.dimension),
  })
  .strict()
  .refine((value) => value.width * value.height <= ATTACHMENT_LIMITS.pixels);

export const AttachmentReferencesSchema = z
  .array(AttachmentReferenceSchema)
  .max(ATTACHMENT_LIMITS.imagesPerMessage)
  .refine(
    (values) =>
      values.reduce((bytes, value) => bytes + value.bytes, 0) <= ATTACHMENT_LIMITS.messageBytes,
  );

export type AttachmentReference = z.infer<typeof AttachmentReferenceSchema>;
export type AttachmentMediaType = z.infer<typeof AttachmentMediaTypeSchema>;

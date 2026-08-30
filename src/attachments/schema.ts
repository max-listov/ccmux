import { z } from 'zod';
import { ChatPrincipalSchema, ManagedPeerSchema } from '../config/schema.ts';
import {
  ATTACHMENT_LIMITS,
  AttachmentDigestSchema,
  AttachmentMediaTypeSchema,
  AttachmentReferenceSchema,
  AttachmentReferencesSchema,
} from './reference.ts';

export const AttachmentUploadSelectorSchema = z
  .object({ target: ManagedPeerSchema, uploadId: z.uuid() })
  .strict();
export const AttachmentBeginSchema = AttachmentUploadSelectorSchema.extend({
  mediaType: AttachmentMediaTypeSchema,
  totalBytes: z.number().int().positive().max(ATTACHMENT_LIMITS.imageBytes),
  digest: AttachmentDigestSchema,
}).strict();
export const AttachmentChunkSchema = AttachmentUploadSelectorSchema.extend({
  offset: z.number().int().nonnegative().max(ATTACHMENT_LIMITS.imageBytes),
  data: z
    .string()
    .min(4)
    .max((ATTACHMENT_LIMITS.chunkBytes / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export const AttachmentReadSchema = z
  .object({
    target: ManagedPeerSchema,
    reference: AttachmentReferenceSchema,
    offset: z.number().int().nonnegative().max(ATTACHMENT_LIMITS.imageBytes),
  })
  .strict();
export const AttachmentUploadReceiptSchema = z
  .object({
    uploadId: z.uuid(),
    receivedBytes: z.number().int().nonnegative().max(ATTACHMENT_LIMITS.imageBytes),
    totalBytes: z.number().int().positive().max(ATTACHMENT_LIMITS.imageBytes),
    expiresAt: z.iso.datetime(),
    phase: z.enum(['uploading', 'verified', 'retained']),
  })
  .strict();
export const AttachmentReadReceiptSchema = z
  .object({
    reference: AttachmentReferenceSchema,
    offset: z.number().int().nonnegative(),
    data: z.string().max((ATTACHMENT_LIMITS.chunkBytes / 3) * 4),
    nextOffset: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();
export const AttachmentCancelReceiptSchema = z
  .object({ uploadId: z.uuid(), cancelled: z.literal(true) })
  .strict();

export const AttachmentRecordSchema = z
  .object({
    id: z.uuid(),
    target: ManagedPeerSchema,
    principal: ChatPrincipalSchema,
    registration: z.uuid(),
    mediaType: AttachmentMediaTypeSchema,
    bytes: z.number().int().positive().max(ATTACHMENT_LIMITS.imageBytes),
    digest: AttachmentDigestSchema,
    received: z.number().int().nonnegative().max(ATTACHMENT_LIMITS.imageBytes),
    phase: z.enum(['uploading', 'verified', 'retained']),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    reference: AttachmentReferenceSchema.nullable(),
  })
  .strict()
  .refine(
    (row) =>
      row.received <= row.bytes &&
      (row.phase === 'uploading'
        ? row.reference === null
        : row.received === row.bytes &&
          row.reference !== null &&
          row.reference.id === row.id &&
          row.reference.digest === row.digest &&
          row.reference.bytes === row.bytes &&
          row.reference.mediaType === row.mediaType),
  );
export const AttachmentPinSchema = z
  .object({
    messageId: z.uuid(),
    target: ManagedPeerSchema,
    registration: z.uuid(),
    principal: ChatPrincipalSchema,
    references: AttachmentReferencesSchema,
  })
  .strict();
export const AttachmentCancellationSchema = z
  .object({
    id: z.uuid(),
    target: ManagedPeerSchema,
    registration: z.uuid(),
    principal: ChatPrincipalSchema,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
export const AttachmentStoreSchema = z
  .object({
    version: z.literal(1),
    records: z.array(AttachmentRecordSchema).max(ATTACHMENT_LIMITS.records),
    pins: z.array(AttachmentPinSchema).max(ATTACHMENT_LIMITS.pins),
    cancelled: z.array(AttachmentCancellationSchema).max(ATTACHMENT_LIMITS.records),
  })
  .strict();

export type AttachmentBegin = z.infer<typeof AttachmentBeginSchema>;
export type AttachmentChunk = z.infer<typeof AttachmentChunkSchema>;
export type AttachmentRead = z.infer<typeof AttachmentReadSchema>;
export type AttachmentUploadSelector = z.infer<typeof AttachmentUploadSelectorSchema>;
export type AttachmentUploadReceipt = z.infer<typeof AttachmentUploadReceiptSchema>;
export type AttachmentReadReceipt = z.infer<typeof AttachmentReadReceiptSchema>;
export type AttachmentCancelReceipt = z.infer<typeof AttachmentCancelReceiptSchema>;
export type AttachmentRecord = z.infer<typeof AttachmentRecordSchema>;
export type AttachmentPin = z.infer<typeof AttachmentPinSchema>;
export type AttachmentStore = z.infer<typeof AttachmentStoreSchema>;

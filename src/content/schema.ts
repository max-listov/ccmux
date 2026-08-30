import { z } from 'zod';
import { ManagedPeerSchema } from '../config/schema.ts';
import { ToolObservationSchema } from './toolSchema.ts';

export const CONTENT_FILE_MAX_BYTES = 512 * 1024;
export const CONTENT_EVENT_BYTES = 4096;
export const CONTENT_REPLAY_BYTES = 192 * 1024;
export const CONTENT_BASELINE_BYTES = 192 * 1024;
export const CONTENT_ITEM_BYTES = 64 * 1024;
export const CONTENT_MAX_RECORDS = 512;
export const CONTENT_MAX_ITEMS = 64;
export const CONTENT_FLUSH_MS = 50;
export const CONTENT_MAX_READERS = 32;

export const ContentCursorSchema = z
  .object({
    generation: z.uuid(),
    sequence: z.number().int().nonnegative(),
  })
  .strict();
export type ContentCursor = z.infer<typeof ContentCursorSchema>;
export const ContentKindSchema = z.enum([
  'assistant',
  'reasoning-summary',
  'tool',
  'usage',
  'request',
  'terminal',
]);
export const ContentRecordSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    at: z.iso.datetime(),
    kind: ContentKindSchema,
    operation: z.enum(['append', 'replace', 'lifecycle']),
    turnId: z.string().min(1).max(256).nullable(),
    itemId: z.string().min(1).max(256),
    revision: z.number().int().positive(),
    offsetBytes: z.number().int().nonnegative(),
    prefixKnown: z.boolean(),
    text: z.string().nullable(),
    totalBytes: z.number().int().nonnegative(),
    omittedBytes: z.number().int().nonnegative(),
    complete: z.boolean(),
    status: z.string().max(128).nullable(),
    tool: ToolObservationSchema.nullable().default(null),
  })
  .strict();
export type ContentRecord = z.infer<typeof ContentRecordSchema>;
export const ContentSnapshotSchema = z
  .object({
    protocol: z.literal(1),
    target: ManagedPeerSchema,
    registrationGeneration: z.uuid().nullable(),
    nativeId: z.string().min(1).max(256),
    generation: z.uuid(),
    sequence: z.number().int().nonnegative(),
    droppedThrough: z.number().int().nonnegative(),
    contextBoundary: z.number().int().nonnegative(),
    omittedRecords: z.number().int().nonnegative(),
    status: z.enum(['live', 'unavailable']),
    records: z.array(ContentRecordSchema).max(CONTENT_MAX_RECORDS),
    baseline: z.array(ContentRecordSchema).max(CONTENT_MAX_ITEMS),
  })
  .strict();
export type ContentSnapshot = z.infer<typeof ContentSnapshotSchema>;
export const ContentReadSchema = ContentSnapshotSchema.omit({
  droppedThrough: true,
  contextBoundary: true,
})
  .extend({
    reset: z.enum(['initial', 'gap', 'generation', 'context']).nullable(),
  })
  .strict();
export type ContentRead = z.infer<typeof ContentReadSchema>;

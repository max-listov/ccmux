import { z } from 'zod';
import { RC_PREFIX_RE } from '../config/schema.ts';

export const EXTERNAL_CONTENT_LIMITS = {
  sourceBytes: 256 * 1024,
  metadataBytes: 256 * 1024,
  textCharacters: 4096,
  entries: 64,
  lookupEntries: 8192,
  lookupDepth: 8,
  responseBytes: 384 * 1024,
};
export const ExternalContentTargetSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    machine: z.string().regex(RC_PREFIX_RE).max(128),
    threadId: z.uuid(),
  })
  .strict();
export const ExternalContentReadSchema = z
  .object({
    target: ExternalContentTargetSchema,
    cursor: z.string().max(2048).nullable().default(null),
    limit: z.number().int().min(1).max(EXTERNAL_CONTENT_LIMITS.entries).default(32),
  })
  .strict();
export const ExternalContentSelectorSchema = z
  .object({ target: ExternalContentTargetSchema })
  .strict();
export const ExternalContentStateSchema = z.enum([
  'available',
  'history-absent',
  'unavailable',
  'stale',
]);
export const ExternalContentEntrySchema = z
  .object({
    id: z.string().max(128),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(EXTERNAL_CONTENT_LIMITS.textCharacters),
    truncated: z.boolean(),
  })
  .strict();
export const ExternalContentResultSchema = z
  .object({
    target: ExternalContentTargetSchema,
    outcome: ExternalContentStateSchema,
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    observedAt: z.iso.datetime(),
    entries: z.array(ExternalContentEntrySchema).max(EXTERNAL_CONTENT_LIMITS.entries),
    nextCursor: z.string().max(2048).nullable(),
    truncated: z.boolean(),
    omittedRecords: z.number().int().nonnegative(),
  })
  .strict();
const UnsupportedControlSchema = z
  .object({
    supported: z.literal(false),
    reason: z.literal('not-exposed'),
  })
  .strict();
export const ExternalContentCapabilitiesSchema = z
  .object({
    target: ExternalContentTargetSchema,
    history: z
      .object({
        outcome: ExternalContentStateSchema,
        source: z.literal('provider-storage'),
        projection: z.literal('authored-text'),
        pageEntries: z.literal(EXTERNAL_CONTENT_LIMITS.entries),
        sourceBytes: z.literal(EXTERNAL_CONTENT_LIMITS.sourceBytes),
      })
      .strict(),
    control: z
      .object({
        message: UnsupportedControlSchema,
        interrupt: UnsupportedControlSchema,
        respond: UnsupportedControlSchema,
        fork: UnsupportedControlSchema,
        compact: UnsupportedControlSchema,
      })
      .strict(),
  })
  .strict();
export type ExternalContentTarget = z.output<typeof ExternalContentTargetSchema>;
export type ExternalContentRead = z.input<typeof ExternalContentReadSchema>;
export type ExternalContentResult = z.output<typeof ExternalContentResultSchema>;
export type ExternalContentEntry = z.output<typeof ExternalContentEntrySchema>;

import { z } from 'zod';
import { TranscriptMessageSchema } from '../agent/transcript/messageSchema.ts';
import { UsageAggregateSchema } from '../usage/schema.ts';

/*
 * The published transcript answer: a window of records with its totals. Every persisted or remote
 * shape has one schema; its type is `z.infer` of it.
 */

// Whole-session composition (counted over the ENTIRE JSONL, not just the loaded window),
// so the header reads true totals that don't drift as you scroll/paginate.
export const TranscriptStatsSchema = z.object({
  messages: z.number(), // conversational turns (user + assistant)
  user: z.number(),
  assistant: z.number(),
  toolCalls: z.number(),
  thinking: z.number(),
  usage: UsageAggregateSchema.optional(),
});

export const TranscriptJsonSchema = z.object({
  version: z.string(),
  generatedAt: z.string(),
  session: z.object({
    name: z.string(),
    uuid: z.string(),
    rc: z.string(),
    dir: z.string(),
    machine: z.string(),
  }),
  source: z.object({
    kind: z.string(),
    path: z.string(),
    available: z.boolean(),
    error: z.string().nullable(),
  }),
  cursor: z.object({
    opaque: z.string().nullable(),
    line: z.number().nullable(),
    byteOffset: z.null(),
    mtimeMs: z.number().nullable(),
  }),
  // Window bounds of THIS response, for backward pagination (infinite-scroll-up):
  // `firstLine` = absolute line the window starts at, `lastLine` = total lines,
  // `reachedStart` = firstLine reaches line 1 (nothing older to load).
  window: z.object({
    firstLine: z.number(),
    lastLine: z.number(),
    reachedStart: z.boolean(),
  }),
  stats: TranscriptStatsSchema,
  messages: z.array(TranscriptMessageSchema),
});

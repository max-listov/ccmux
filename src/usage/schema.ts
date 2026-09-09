import { z } from 'zod';

export const USAGE_MAX_BYTES = 256 * 1024;
export const USAGE_SLICE_BYTES = 64 * 1024;
export const UsageMetricsSchema = z
  .object({
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    cacheReadTokens: z.int().nonnegative().nullable(),
    cacheCreationTokens: z.int().nonnegative().nullable(),
    reasoningTokens: z.int().nonnegative().nullable(),
    totalTokens: z.int().nonnegative().nullable(),
  })
  .strict();
export type UsageMetrics = z.infer<typeof UsageMetricsSchema>;
export const UsageProvenanceSchema = z.record(UsageMetricsSchema.keyof(), z.string().max(64));
export const UsageDetailsSchema = z
  .object({
    canonicalModel: z.string().max(256).nullable(),
    costBasis: z.enum(['list', 'managed', 'unknown']).nullable(),
    webSearchRequests: z.int().nonnegative().nullable(),
    contextWindow: z.int().nonnegative().nullable(),
    maxOutputTokens: z.int().nonnegative().nullable(),
  })
  .strict();
export const USAGE_FIELDS = UsageMetricsSchema.keyof().options;
export function emptyUsage(): UsageMetrics {
  return {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  };
}
export const UsageFactSchema = z
  .object({
    id: z.string().min(1).max(512),
    runtime: z.enum(['claude', 'codex', 'opencode', 'custom']),
    model: z.string().max(256).nullable(),
    provider: z.string().max(128).nullable(),
    at: z.iso.datetime().nullable(),
    observedAt: z.iso.datetime(),
    scope: z.enum(['message', 'turn', 'run', 'session']),
    mode: z.enum(['replacement', 'cumulative']),
    epoch: z.string().min(1).max(256),
    inputIncludesCache: z.boolean().nullable(),
    outputIncludesReasoning: z.boolean().nullable(),
    metrics: UsageMetricsSchema,
    provenance: UsageProvenanceSchema.optional(),
    cost: z
      .object({
        value: z.number().nonnegative(),
        currency: z.string().min(1).max(16),
        provenance: z.string().max(64).optional(),
      })
      .strict()
      .nullable(),
    identity: z.enum(['native', 'record']),
    details: UsageDetailsSchema.optional(),
    counterAmbiguous: z.boolean().optional(),
  })
  .strict();
export type UsageFact = z.infer<typeof UsageFactSchema>;

export const UsageQuerySchema = z
  .object({
    since: z.iso
      .datetime()
      .transform((value) => new Date(value).toISOString())
      .optional(),
    until: z.iso
      .datetime()
      .transform((value) => new Date(value).toISOString())
      .optional(),
    timezone: z
      .string()
      .max(128)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid IANA timezone')
      .default('UTC'),
    cursor: z.string().max(2048).nullable().default(null),
    pipelineCursor: z.string().max(2048).nullable().default(null),
    limit: z.int().min(1).max(100).default(100),
  })
  .strict()
  .refine((q) => !q.since || !q.until || q.since < q.until, 'Expected since < until')
  .refine(
    (q) => !q.since || !q.until || Date.parse(q.until) - Date.parse(q.since) <= 366 * 86_400_000,
    'Explicit intervals are limited to 366 days',
  );
export type UsageQuery = z.output<typeof UsageQuerySchema>;
export const UsageReadSchema = z
  .object({
    address: z.string().min(1).max(512),
    query: UsageQuerySchema.prefault({}),
  })
  .strict();
export const UsageListSchema = z
  .object({
    query: UsageQuerySchema.prefault({}),
    cursor: z.string().max(2048).nullable().default(null),
    limit: z.int().min(1).max(100).default(100),
  })
  .strict();

export const UsageAggregateSchema = z
  .object({
    values: UsageMetricsSchema,
    observations: z.int().nonnegative(),
    measured: z.record(UsageMetricsSchema.keyof(), z.int().nonnegative()),
    fieldCoverage: z.record(UsageMetricsSchema.keyof(), z.enum(['full', 'partial', 'unknown'])),
    coverage: z.enum(['full', 'partial', 'unknown']),
    costs: z
      .array(
        z
          .object({
            currency: z.string(),
            reported: z.number().nonnegative(),
            observations: z.int().nonnegative(),
            provenance: z.string().nullable(),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type UsageAggregate = z.infer<typeof UsageAggregateSchema>;
export const UsageBucketSchema = z
  .object({
    day: z.string().nullable(),
    model: z.string().nullable(),
    provider: z.string().nullable(),
    inputIncludesCache: z.boolean().nullable(),
    outputIncludesReasoning: z.boolean().nullable(),
    details: UsageDetailsSchema.optional(),
    provenance: UsageProvenanceSchema.optional(),
    ...UsageAggregateSchema.shape,
  })
  .strict();
export type UsageBucket = z.infer<typeof UsageBucketSchema>;
const UsageEventRangeSchema = z
  .object({ first: z.iso.datetime().nullable(), last: z.iso.datetime().nullable() })
  .strict();
export const UsageSummarySchema = z
  .object({
    address: z.string(),
    runtime: z.string(),
    identity: z
      .object({ sessionId: z.string().nullable(), nativeSessionId: z.string().nullable() })
      .strict(),
    additivity: z.literal('session-only'),
    source: z.enum(['readable', 'missing', 'unreadable', 'unsupported']),
    state: z.enum(['building', 'ready', 'stale', 'failed']),
    reason: z.string().nullable(),
    revision: z.string(),
    observedAt: z.iso.datetime().nullable(),
    sourceEventRange: UsageEventRangeSchema,
    indexedBytes: z.int().nonnegative(),
    sourceBytes: z.int().nonnegative().nullable(),
    malformedRecords: z.int().nonnegative(),
    history: z.enum(['native-history', 'observed-live']),
    self: UsageAggregateSchema,
    unattributed: UsageAggregateSchema,
    delegated: z
      .object({
        coverage: z.enum(['unknown', 'partial', 'full']),
        addresses: z.array(z.string()).max(100),
      })
      .strict(),
    reportedPipeline: z
      .object({
        scope: z.literal('query-pipeline-inclusive'),
        sourceEventRange: UsageEventRangeSchema,
        usage: UsageAggregateSchema,
        state: z.enum(['building', 'ready']),
        reset: z.boolean(),
        unattributed: UsageAggregateSchema,
        buckets: z.array(UsageBucketSchema).max(100),
        nextCursor: z.string().nullable(),
      })
      .strict()
      .nullable(),
    buckets: z.array(UsageBucketSchema).max(100),
    timezone: z.string(),
    nextCursor: z.string().nullable(),
    reset: z.boolean(),
  })
  .strict();
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
export const UsageListResultSchema = z
  .object({
    machine: z.string(),
    data: z.array(UsageSummarySchema).max(100),
    nextCursor: z.string().nullable(),
    reset: z.boolean(),
  })
  .strict();

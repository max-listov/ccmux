import { z } from 'zod';

export const NativeModelSelectionSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    model: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9~][a-zA-Z0-9._:/+~-]*$/),
  })
  .strict();
export const NativeTurnOptionsSchema = z.discriminatedUnion('runtime', [
  z
    .object({
      runtime: z.literal('codex'),
      model: NativeModelSelectionSchema,
      mode: z.enum(['default', 'plan']),
      effort: z
        .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
        .optional(),
    })
    .strict(),
  z
    .object({
      runtime: z.literal('opencode'),
      model: NativeModelSelectionSchema,
      agent: z.string().min(1).max(128).optional(),
      variant: z.string().min(1).max(128).optional(),
    })
    .strict(),
]);
export type NativeTurnOptions = z.infer<typeof NativeTurnOptionsSchema>;
export const AcceptedTurnOptionsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    options: NativeTurnOptionsSchema,
  })
  .strict();
export type AcceptedTurnOptions = z.infer<typeof AcceptedTurnOptionsSchema>;
export const NativeSelectionEvidenceSchema = z
  .object({
    model: NativeModelSelectionSchema,
    options: NativeTurnOptionsSchema.nullable(),
    source: z.enum(['admission', 'settings', 'assistant', 'reroute']),
    turnId: z.string().min(1).max(256).nullable(),
  })
  .strict();
export type NativeSelectionEvidence = z.infer<typeof NativeSelectionEvidenceSchema>;

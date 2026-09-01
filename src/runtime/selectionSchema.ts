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
  z.object({ runtime: z.literal('custom'), model: NativeModelSelectionSchema }).strict(),
  z
    .object({
      runtime: z.literal('claude'),
      model: NativeModelSelectionSchema,
      /**
       * How hard the model should think.
       *
       * A bounded string, not a fixed set of names: which levels exist is a property of the model,
       * the runtime reports it per model in the catalog, and `validateTurnOptions` refuses anything
       * the catalog does not list. A closed enum here would be a second, staler authority beside
       * that one — it would reject a level the runtime accepts until someone edited this line.
       *
       * The argument holds for every runtime that publishes its levels, so the codex branch below
       * is bounded the same way.
       */
      effort: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z
    .object({
      runtime: z.literal('codex'),
      model: NativeModelSelectionSchema,
      mode: z.enum(['default', 'plan']),
      /** Bounded the same way, and for the same reason, as the branch above. */
      effort: z.string().min(1).max(64).optional(),
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
export type NativeModelSelection = z.infer<typeof NativeModelSelectionSchema>;
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

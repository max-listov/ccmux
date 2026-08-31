import { z } from 'zod';
import { NativeModelSelectionSchema } from '../runtime/selectionSchema.ts';
import { PolicyDigestSchema, PolicyIdSchema } from './reference.ts';

/** Observed execution evidence, not a second caller-selectable policy or credential mechanism. */
export const RuntimeAppliedProfileSchema = z
  .object({
    runtime: z.literal('custom'),
    turnId: z.string().min(1).max(256),
    observedAt: z.iso.datetime(),
    recipeDigest: PolicyDigestSchema,
    model: NativeModelSelectionSchema,
    /** The host's name for the server that answered, when it declared one. Never part of identity. */
    providerLabel: z.string().max(64).nullable().default(null),
    tools: z.array(PolicyIdSchema).max(16),
    resources: z
      .array(
        z
          .object({
            id: PolicyIdSchema,
            digest: PolicyDigestSchema,
            kind: z.enum(['instruction', 'skill', 'resource']),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type RuntimeAppliedProfile = z.infer<typeof RuntimeAppliedProfileSchema>;

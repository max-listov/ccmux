import { z } from 'zod';
import { NativeAccountSchema, NativeSnapshotSchema } from '../../../runtime/projectionSchema.ts';

export const OwnedCodexSnapshotSchema = NativeSnapshotSchema.extend({
  provider: z.literal('codex'),
});
export type OwnedCodexSnapshot = z.infer<typeof OwnedCodexSnapshotSchema>;
export const OwnedCodexReadSchema = z
  .object({
    protocol: z.literal(1),
    status: z.enum(['live', 'stale', 'unavailable']),
    reason: z.string().nullable(),
    snapshot: OwnedCodexSnapshotSchema.nullable(),
    /** What stays true after the runtime stops — see `ManagedRuntimeReadSchema.retained`. */
    retained: z.object({ account: NativeAccountSchema.nullable() }).strict().nullable().optional(),
  })
  .strict();
export type OwnedCodexRead = z.infer<typeof OwnedCodexReadSchema>;

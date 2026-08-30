import { z } from 'zod';
import { NativeSnapshotSchema } from '../../runtime/projectionSchema.ts';

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
  })
  .strict();
export type OwnedCodexRead = z.infer<typeof OwnedCodexReadSchema>;

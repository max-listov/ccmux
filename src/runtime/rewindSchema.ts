import { z } from 'zod';

/**
 * What a rewind of a session's files did, or would do.
 *
 * Kept apart from the service that performs one because a control-plane schema travels into the
 * packed client, and a client has no filesystem: a schema living beside `node:fs` drags it there.
 */
export const RewindResultSchema = z
  .object({
    canRewind: z.boolean(),
    error: z.string().max(512).nullable(),
    filesChanged: z.array(z.string().max(1_024)).max(512),
    insertions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
    /**
     * Paths the runtime refused to restore because they are no longer safely the file it recorded.
     * Reported, never counted as success: a rewind that silently skipped a file would tell a person
     * their tree is back when part of it is not. Null on a preview, which cannot have refusals.
     */
    skippedLinks: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type RewindResult = z.infer<typeof RewindResultSchema>;

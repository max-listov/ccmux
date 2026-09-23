import { z } from 'zod';

export const ControlDirectoryReadSchema = z
  .object({
    path: z.string().startsWith('/').max(4096).optional(),
    cursor: z.string().max(8192).nullable().default(null),
    limit: z.number().int().min(1).max(512).default(128),
    includeHidden: z.boolean().default(false),
  })
  .strict();
export const ControlDirectoryEntrySchema = z
  .object({
    name: z.string().max(1024),
    kind: z.enum(['dir', 'file', 'symlink', 'other']),
    path: z.string().max(4096),
  })
  .strict();
export const ControlDirectoryResultSchema = z
  .object({
    path: z.string().max(4096),
    parent: z.string().max(4096).nullable(),
    entries: z.array(ControlDirectoryEntrySchema).max(512),
    nextCursor: z.string().max(8192).nullable(),
  })
  .strict();
export type ControlDirectoryRead = z.input<typeof ControlDirectoryReadSchema>;
export type ControlDirectoryResult = z.infer<typeof ControlDirectoryResultSchema>;

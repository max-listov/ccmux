import { z } from 'zod';

const Resource = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\p{Cc}\p{Cf}]+$/u)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 1024,
    'Permission pattern exceeds byte budget',
  );
const Resources = z
  .object({
    patterns: z.array(Resource).max(8),
    omitted: z.number().int().nonnegative(),
    complete: z.boolean(),
  })
  .strict();
export const PermissionScopeSchema = z
  .object({
    operation: z.string().min(1).max(128),
    kind: z.literal('filesystem-patterns'),
    requested: Resources,
    session: Resources,
  })
  .strict();
export type PermissionScope = z.infer<typeof PermissionScopeSchema>;

function resources(values: string[] | undefined): z.infer<typeof Resources> {
  const patterns: string[] = [];
  let omitted = 0;
  for (const value of values ?? []) {
    const result = Resource.safeParse(value);
    if (patterns.length < 8 && result.success) patterns.push(result.data);
    else omitted++;
  }
  return { patterns, omitted, complete: values !== undefined && omitted === 0 };
}

/** Native filesystem patterns are display context, never caller authorization or raw tool input. */
export function openCodePermissionScope(request: {
  permission: string;
  patterns?: string[] | undefined;
  always?: string[] | undefined;
}): PermissionScope | null {
  if (!['external_directory', 'read', 'edit', 'glob', 'grep', 'list'].includes(request.permission))
    return null;
  return {
    operation: request.permission,
    kind: 'filesystem-patterns',
    requested: resources(request.patterns),
    session: resources(request.always),
  };
}

import { z } from 'zod';

export const ProfileNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const ProfileDirectorySchema = z.string().startsWith('/').max(4096);
const accountDigest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();
const named = { name: ProfileNameSchema, configDir: ProfileDirectorySchema, accountDigest };

/** The implicit Claude login and an explicit directory are different provider contexts. */
export const ClaudeProfileBindingSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('default'),
    name: z.literal('default'),
    configDir: z.null(),
    accountDigest,
  }),
  z.strictObject({ ...named, source: z.literal('machine') }),
  z.strictObject({
    ...named,
    source: z.literal('claude-multiprofile'),
    registryPath: ProfileDirectorySchema,
  }),
]);
export type ClaudeProfileBinding = z.infer<typeof ClaudeProfileBindingSchema>;

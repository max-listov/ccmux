import { z } from 'zod';
import {
  type ClaudeProfileBinding,
  ClaudeProfileBindingSchema,
  ProfileDirectorySchema,
  ProfileNameSchema,
} from './claudeProfileSchema.ts';

const accountDigest = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .optional();

/** Machine-level declaration for a named Antigravity CLI profile (`machine.json`). */
export const AntigravityProfileConfigSchema = z.strictObject({
  dataDir: ProfileDirectorySchema,
});
export type AntigravityProfileConfig = z.infer<typeof AntigravityProfileConfigSchema>;

/** Pinned Antigravity account context stored on a session registration. */
export const AntigravityProfileBindingSchema = z.discriminatedUnion('source', [
  z.strictObject({
    agent: z.literal('antigravity'),
    source: z.literal('default'),
    name: z.literal('default'),
    dataDir: z.null(),
    storage: z.literal('default'),
    accountDigest,
  }),
  z.strictObject({
    agent: z.literal('antigravity'),
    source: z.literal('machine'),
    name: ProfileNameSchema,
    dataDir: ProfileDirectorySchema,
    storage: z.literal('file'),
    accountDigest,
  }),
]);
export type AntigravityProfileBinding = z.infer<typeof AntigravityProfileBindingSchema>;

/**
 * Backward-compatible union of Claude and Antigravity session profile bindings.
 * Existing `sessions.jsonl` rows carry Claude bindings without an `agent` discriminator and
 * continue to parse identically.
 */
export const SessionProfileBindingSchema = z.union([
  ClaudeProfileBindingSchema,
  AntigravityProfileBindingSchema,
]);
export type SessionProfileBinding = z.infer<typeof SessionProfileBindingSchema>;

export function isAntigravityProfileBinding(
  binding: SessionProfileBinding | undefined,
): binding is AntigravityProfileBinding {
  return binding !== undefined && 'agent' in binding && binding.agent === 'antigravity';
}

export function isClaudeProfileBinding(
  binding: SessionProfileBinding | undefined,
): binding is ClaudeProfileBinding {
  return binding !== undefined && !('agent' in binding);
}

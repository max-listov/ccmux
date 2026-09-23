import { z } from 'zod';
import { CustomLaunchConfigSchema } from '../agent/custom/config.ts';
import { NativeModelSelectionSchema } from '../runtime/selectionSchema.ts';

/*
 * Launch inputs: permission modes, native session identity and launch recipes. Every persisted or
 * remote shape has one schema; its type is `z.infer` of it.
 */

/** Any Claude Code permission mode (matches `claude --permission-mode` choices).
 *  Shared by the machine default and the per-session override so the two can't drift. */
export const PermissionModeSchema = z.enum([
  'auto',
  'manual',
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
]);

/** Provider continuation is not the managed registration UUID. */
export const NativeSessionSchema = z
  .object({
    runtime: z.enum(['opencode', 'custom', 'claude']),
    id: z.string().min(1).max(256),
    version: z.string().min(1).max(64),
  })
  .strict();

/** Public-safe identity of an execution-host launch recipe. The reference contains no path,
 * command, environment value or provider credential. */
export const LaunchRecipeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/);
export const LaunchRecipeRevisionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const LaunchRecipeCapabilitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9._-]*$/);
/** Native provider collaboration modes that a host recipe may pin. The public caller never sends
 * the mode or its settings; it selects only the immutable recipe reference. */
export const CodexCollaborationModeSchema = z.enum(['default', 'plan']);
export const LaunchRecipeReferenceSchema = z
  .object({
    id: LaunchRecipeIdSchema,
    revision: LaunchRecipeRevisionSchema,
  })
  .strict();
export const ModelSelectionSchema = NativeModelSelectionSchema;
export const LaunchRecipeMetadataSchema = LaunchRecipeReferenceSchema.extend({
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  capabilities: z.array(LaunchRecipeCapabilitySchema).max(32),
  collaborationMode: CodexCollaborationModeSchema.optional(),
}).strict();

/** Private host configuration. Values stay on the execution host; only LaunchRecipeMetadata is
 * projected through control APIs. `environment` names capabilities the recipe requires without
 * carrying their values, and `flags` goes through the existing owned App Server allowlist. */
export const MachineLaunchRecipeSchema = z
  .object({
    revision: LaunchRecipeRevisionSchema,
    envFile: z.string().min(1).optional(),
    flags: z.array(z.string().min(1).max(4_096)).max(32).default([]),
    environment: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(32)
      .default([]),
    capabilities: z.array(LaunchRecipeCapabilitySchema).max(32).default([]),
    /** Select the provider's installed preset on every turn. Model, effort and built-in instructions
     * are resolved from the provider; the recipe stores no caller-authored prompt. */
    collaborationMode: CodexCollaborationModeSchema.optional(),
    custom: CustomLaunchConfigSchema.optional(),
  })
  .strict();

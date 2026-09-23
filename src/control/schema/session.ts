import { z } from 'zod';
import { AgentKindSchema, ManagedPeerSchema, SESSION_NAME_RE } from '../../chat/identitySchema.ts';
import {
  LaunchRecipeMetadataSchema,
  LaunchRecipeReferenceSchema,
  ModelSelectionSchema,
  NativeSessionSchema,
} from '../../config/launchSchema.ts';
import {
  ApplicationPolicyEvidenceSchema,
  ApplicationPolicyReferenceSchema,
} from '../../policy/reference.ts';
import { RuntimeCapabilitiesSchema } from '../../runtime/capabilities.ts';

export const ControlCreateSchema = z
  .object({
    runtime: AgentKindSchema.optional(),
    /**
     * Which execution mode of that agent, where it has more than one.
     *
     * Omitted keeps each agent's established mode, so every existing caller is unchanged. It exists
     * because the field above names an agent family, and for Claude that no longer selects a single
     * way to run: without this, the native mode is unreachable through the control plane entirely.
     */
    mode: z.enum(['tui', 'native']).optional(),
    requestId: z.uuid(),
    name: z.string().min(1).max(256).regex(SESSION_NAME_RE),
    workspace: z.string().startsWith('/').max(4_096),
    flags: z.array(z.string().max(4_096)).max(32).default([]),
    launchRecipe: LaunchRecipeReferenceSchema.optional(),
    modelSelection: ModelSelectionSchema.optional(),
    applicationPolicy: ApplicationPolicyReferenceSchema.optional(),
  })
  .strict();
export type ControlCreate = z.input<typeof ControlCreateSchema>;
export const ControlCreateReceiptSchema = z
  .object({
    requestId: z.uuid(),
    target: ManagedPeerSchema,
    workspace: z.string().startsWith('/').max(4_096),
    registrationGeneration: z.uuid(),
    duplicate: z.boolean(),
    launchRecipe: LaunchRecipeMetadataSchema.optional(),
    modelSelection: ModelSelectionSchema.optional(),
    applicationPolicy: ApplicationPolicyEvidenceSchema.optional(),
    nativeSession: NativeSessionSchema.optional(),
    driverCapabilities: RuntimeCapabilitiesSchema.optional(),
  })
  .strict();
export type ControlCreateReceipt = z.infer<typeof ControlCreateReceiptSchema>;
export const ControlArchiveReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    archived: z.literal(true),
    duplicate: z.boolean(),
    stopped: z.boolean(),
  })
  .strict();
export type ControlArchiveReceipt = z.infer<typeof ControlArchiveReceiptSchema>;

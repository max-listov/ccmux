import { z } from 'zod';
import { ManagedPeerSchema } from '../../chat/identitySchema.ts';
import { LaunchRecipeMetadataSchema, NativeSessionSchema } from '../../config/launchSchema.ts';
import { ApplicationPolicyEvidenceSchema } from '../../policy/reference.ts';
import { RuntimeAppliedProfileSchema } from '../../policy/runtimeProfile.ts';
import { RuntimeCapabilitiesSchema } from '../../runtime/capabilities.ts';
import { NativeTurnSchema } from '../../runtime/projectionSchema.ts';
import {
  AcceptedTurnOptionsSchema,
  NativeSelectionEvidenceSchema,
} from '../../runtime/selectionSchema.ts';

export const CONTROL_MAX_BYTES = 512 * 1024;
export const CONTROL_MAX_READERS = 32;
export const ControlTargetSchema = z.object({ target: ManagedPeerSchema }).strict();
export const ControlRowSchema = z
  .object({
    identity: ManagedPeerSchema,
    runtime: z.enum(['cli', 'app-server', 'native']),
    nativeSession: NativeSessionSchema.optional(),
    driverCapabilities: RuntimeCapabilitiesSchema.optional(),
    state: z.enum([
      'working',
      'idle',
      'waiting-approval',
      'waiting-input',
      'prompt',
      'stopped',
      'blocked',
      'unknown',
    ]),
    availability: z.enum(['live', 'stale', 'unavailable']),
    reason: z.string().max(512).nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    turn: NativeTurnSchema.nullable(),
    model: z.string().max(512).nullable(),
    launchRecipe: LaunchRecipeMetadataSchema.optional(),
    selection: AcceptedTurnOptionsSchema.nullable(),
    nativeSelection: NativeSelectionEvidenceSchema.nullable(),
    applicationPolicy: ApplicationPolicyEvidenceSchema.optional(),
    nativeProfile: RuntimeAppliedProfileSchema.optional(),
    capabilities: z
      .object({
        message: z.boolean(),
        start: z.boolean(),
        interrupt: z.boolean(),
        wait: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ControlRow = z.infer<typeof ControlRowSchema>;
export const ControlSnapshotSchema = z
  .object({
    protocol: z.literal(1),
    version: z.string().max(64),
    machine: z.string().max(128),
    generation: z.uuid(),
    sequence: z.number().int().nonnegative(),
    status: z.enum(['live', 'stale', 'unavailable']),
    reason: z.string().max(512).nullable(),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    omitted: z.number().int().nonnegative(),
    sessions: z.array(ControlRowSchema).max(256),
  })
  .strict();
export type ControlSnapshot = z.infer<typeof ControlSnapshotSchema>;

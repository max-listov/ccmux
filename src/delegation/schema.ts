import { z } from 'zod';
import { ManagedPeerSchema } from '../chat/identitySchema.ts';

/** Read access covers the host; write access is limited to the canonical workspace. */
export const DelegatedPolicySchema = z
  .object({
    access: z.enum(['read-only', 'workspace-write', 'full-access']),
    readScope: z.literal('host'),
    workspace: z.string().startsWith('/').max(4096),
    network: z.literal(false),
  })
  .strict();
export type DelegatedPolicy = z.infer<typeof DelegatedPolicySchema>;
export const DelegationParentSchema = z
  .object({
    target: ManagedPeerSchema,
    registrationGeneration: z.uuid(),
  })
  .strict();
export const DelegationRequestSchema = z
  .object({
    parent: DelegationParentSchema,
    policy: DelegatedPolicySchema,
    deadlineAt: z.iso.datetime().optional(),
  })
  .strict();
export type DelegationRequest = z.infer<typeof DelegationRequestSchema>;
/** Host-owned grants are exact registrations, never inferred from names or prompts. */
export const DelegationAuthoritySchema = DelegationRequestSchema;
export const DelegationSchema = DelegationRequestSchema.extend({
  requestId: z.uuid(),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type Delegation = z.infer<typeof DelegationSchema>;
export const DelegationEvidenceSchema = z
  .object({
    delegation: DelegationSchema,
    state: z.enum(['applied', 'unavailable']),
    generation: z.uuid().nullable(),
    observedAt: z.iso.datetime(),
  })
  .strict();

export const DelegationCancelSchema = z
  .object({
    parent: DelegationParentSchema,
    target: ManagedPeerSchema,
    registrationGeneration: z.uuid(),
    operationId: z.uuid(),
  })
  .strict();
export const DelegationCancelReceiptSchema = z
  .object({
    target: ManagedPeerSchema,
    registrationGeneration: z.uuid(),
    operationId: z.uuid(),
    stopped: z.literal(true),
  })
  .strict();

import { z } from 'zod';
import { RC_PREFIX_RE } from '../chat/identitySchema.ts';
import { MessageAttributionSchema } from '../chat/originSchema.ts';

/** An application run is an attested authority, never a managed session registration. */
export const ApplicationParentSchema = z
  .object({
    kind: z.literal('application'),
    machine: z.string().regex(RC_PREFIX_RE),
    applicationId: MessageAttributionSchema.shape.applicationId,
    authorityId: z.uuid(),
  })
  .strict();
export const ApplicationBindingSchema = MessageAttributionSchema.extend({
  actor: z.literal('agent'),
  revision: z.string().min(1).max(128),
}).strict();
const PolicySchema = z
  .object({
    access: z.enum(['read-only', 'workspace-write']),
    readScope: z.literal('host'),
    workspace: z.string().startsWith('/').max(4096),
    network: z.literal(false),
  })
  .strict();
export const ApplicationDelegationGrantSchema = z
  .object({
    binding: ApplicationBindingSchema,
    policy: PolicySchema,
    leaseMs: z.number().int().min(1_000).max(60_000),
    lifetimeMs: z.number().int().min(1_000).max(86_400_000),
  })
  .strict();
export const ApplicationAuthorityOpenSchema = z
  .object({
    operationId: z.uuid(),
    binding: ApplicationBindingSchema,
    conversationId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    sourceMessageRef: z.string().min(1).max(256),
    authorizationQuote: z
      .string()
      .min(1)
      .max(4000)
      .refine((value) => value.trim().length > 0),
  })
  .strict();
export const ApplicationAuthoritySelectorSchema = z
  .object({
    parent: z
      .object({
        target: ApplicationParentSchema,
        registrationGeneration: z.uuid(),
      })
      .strict(),
  })
  .strict();
export const ApplicationAuthorityUpdateSchema = ApplicationAuthoritySelectorSchema.extend({
  operationId: z.uuid(),
  expectedExpiresAt: z.iso.datetime().optional(),
}).strict();
export const ApplicationAuthoritySchema = ApplicationAuthorityOpenSchema.extend({
  parent: ApplicationAuthoritySelectorSchema.shape.parent,
  caller: z.string().regex(RC_PREFIX_RE),
  assurance: z.literal('application-attested'),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policy: PolicySchema,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  lastOperationId: z.uuid(),
}).strict();
export const ApplicationAuthorityCapabilitiesSchema = z
  .object({
    bindings: z.array(ApplicationDelegationGrantSchema).max(64),
    assurance: z.literal('application-attested'),
    requiresTrustedRunAttestation: z.literal(true),
  })
  .strict();

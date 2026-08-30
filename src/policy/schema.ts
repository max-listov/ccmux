import { z } from 'zod';
import {
  ApplicationPolicyMetadataSchema,
  PolicyDigestSchema as DigestSchema,
  PolicyIdSchema as IdSchema,
} from './reference.ts';

export type {
  ApplicationPolicyEvidence,
  ApplicationPolicyMetadata,
  ApplicationPolicyReference,
} from './reference.ts';
export {
  ApplicationPolicyEvidenceSchema,
  ApplicationPolicyMetadataSchema,
  ApplicationPolicyReferenceSchema,
} from './reference.ts';

const PathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.includes('\0') &&
      (value === '/' ||
        value
          .slice(1)
          .split('/')
          .every((part) => part !== '' && part !== '.' && part !== '..')),
    'canonical absolute path required',
  );

/** Host configuration only. Public requests carry a reference, never these paths or source text. */
export const PolicySourceSchema = z
  .object({ id: IdSchema, path: PathSchema, sha256: DigestSchema })
  .strict();
const NativeSkillSchema = PolicySourceSchema.extend({ name: IdSchema }).strict();
const hostFields = { revision: IdSchema, trustedRoots: z.array(PathSchema).min(1).max(16) };
export const CodexAgentPolicySchema = z
  .object({
    ...hostFields,
    runtime: z.literal('codex'),
    instructionSources: z.array(PolicySourceSchema).max(16).default([]),
    skills: z.array(NativeSkillSchema).max(16).default([]),
  })
  .strict()
  .refine(
    (value) => value.instructionSources.length + value.skills.length > 0,
    'policy requires a canonical source',
  );
export const OpenCodeAgentPolicySchema = z
  .object({
    ...hostFields,
    runtime: z.literal('opencode'),
    agent: z.object({ name: IdSchema, source: PolicySourceSchema }).strict(),
    denyTools: z.array(IdSchema).max(64).default([]),
  })
  .strict();
export const HostAgentPolicySchema = z.discriminatedUnion('runtime', [
  CodexAgentPolicySchema,
  OpenCodeAgentPolicySchema,
]);
export const AgentPoliciesSchema = z.record(IdSchema, HostAgentPolicySchema).default({});
export type AgentPolicies = z.infer<typeof AgentPoliciesSchema>;
export type HostAgentPolicy = z.infer<typeof HostAgentPolicySchema>;
export type PolicySource = z.infer<typeof PolicySourceSchema>;

const PrivateSourceSchema = PolicySourceSchema.extend({ body: z.string() }).strict();
export const MaterializedPolicySchema = z.discriminatedUnion('runtime', [
  z
    .object({
      runtime: z.literal('codex'),
      metadata: ApplicationPolicyMetadataSchema,
      instructionSources: z.array(PrivateSourceSchema),
      skills: z.array(PrivateSourceSchema.extend({ name: IdSchema }).strict()),
    })
    .strict(),
  z
    .object({
      runtime: z.literal('opencode'),
      metadata: ApplicationPolicyMetadataSchema,
      agent: z.object({ name: IdSchema, source: PrivateSourceSchema, prompt: z.string() }).strict(),
      denyTools: z.array(IdSchema),
    })
    .strict(),
]);
export type MaterializedPolicy = z.infer<typeof MaterializedPolicySchema>;

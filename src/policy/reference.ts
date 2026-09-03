import { z } from 'zod';

export const PolicyIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const PolicyDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ApplicationPolicyReferenceSchema = z
  .object({ id: PolicyIdSchema, revision: PolicyIdSchema })
  .strict();
export type ApplicationPolicyReference = z.infer<typeof ApplicationPolicyReferenceSchema>;
export const PolicyCapabilitySchema = z.enum([
  'developer-instructions',
  'native-skills',
  'native-agent',
  'tool-denials',
]);
export const ApplicationPolicyMetadataSchema = ApplicationPolicyReferenceSchema.extend({
  digest: PolicyDigestSchema,
  runtime: z.enum(['codex', 'opencode']),
  sources: z
    .array(
      z
        .object({
          id: PolicyIdSchema,
          digest: PolicyDigestSchema,
          kind: z.enum(['instructions', 'skill', 'agent']),
        })
        .strict(),
    )
    .min(1)
    .max(32),
  capabilities: z.array(PolicyCapabilitySchema).min(1).max(4),
}).strict();
export type ApplicationPolicyMetadata = z.infer<typeof ApplicationPolicyMetadataSchema>;
/**
 * Why a policy is not applied, as a code — never a message, a path or a native error.
 *
 * `unavailable` alone is a state with no action in it. The reason was known at the moment of the
 * refusal and named precisely — `native-agent-selection-unavailable`, `source-digest-mismatch` —
 * and stopped at the process boundary, so a consumer read "the policy is unavailable" and went
 * looking through this project's sources for which of a dozen conditions it was. That cost an hour
 * for a directory named `agents/` where the runtime reads `agent/`.
 *
 * Required of every producer in this version and not by the schema, deliberately: a snapshot the
 * previous version left on disk carries `unavailable` with no reason, and a schema that refused it
 * would drop that whole snapshot on the floor at read time — turning a missing sentence into a lost
 * projection, which is a worse version of the same defect. What the schema does forbid is a reason
 * on a state that is not a failure.
 *
 * A pattern rather than an enum: the codes come from three vocabularies that grow independently —
 * policy verification, the runtime's own availability, and the connection — and an enum here would
 * either go stale silently or drop a reason it had never heard of, which is the failure this field
 * exists to end. The charset is what keeps it a code.
 */
export const PolicyUnavailableReasonSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const ApplicationPolicyEvidenceSchema = z
  .object({
    policy: ApplicationPolicyMetadataSchema,
    state: z.enum(['desired', 'applied', 'unavailable']),
    /** Set by every producer here when the state is `unavailable`, and meaningless on any other. */
    reason: PolicyUnavailableReasonSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.reason === undefined || value.state === 'unavailable',
    'Only an unavailable policy has a reason',
  );
export type ApplicationPolicyEvidence = z.infer<typeof ApplicationPolicyEvidenceSchema>;

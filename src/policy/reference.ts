import { z } from "zod";

export const PolicyIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const PolicyDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const ApplicationPolicyReferenceSchema = z.object({ id: PolicyIdSchema, revision: PolicyIdSchema }).strict();
export type ApplicationPolicyReference = z.infer<typeof ApplicationPolicyReferenceSchema>;
export const PolicyCapabilitySchema = z.enum(["developer-instructions", "native-skills", "native-agent", "tool-denials"]);
export const ApplicationPolicyMetadataSchema = ApplicationPolicyReferenceSchema.extend({
  digest: PolicyDigestSchema,
  runtime: z.enum(["codex", "opencode"]),
  sources: z.array(z.object({ id: PolicyIdSchema, digest: PolicyDigestSchema,
    kind: z.enum(["instructions", "skill", "agent"]) }).strict()).min(1).max(32),
  capabilities: z.array(PolicyCapabilitySchema).min(1).max(4),
}).strict();
export type ApplicationPolicyMetadata = z.infer<typeof ApplicationPolicyMetadataSchema>;
export const ApplicationPolicyEvidenceSchema = z.object({
  policy: ApplicationPolicyMetadataSchema,
  state: z.enum(["desired", "applied", "unavailable"]),
}).strict();
export type ApplicationPolicyEvidence = z.infer<typeof ApplicationPolicyEvidenceSchema>;

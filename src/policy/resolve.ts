import { stableJson } from "../agent/launchInputs.ts";
import { AgentPoliciesSchema, ApplicationPolicyEvidenceSchema, ApplicationPolicyMetadataSchema,
  ApplicationPolicyReferenceSchema, MaterializedPolicySchema } from "./schema.ts";
import type { AgentPolicies, ApplicationPolicyEvidence, ApplicationPolicyMetadata,
  ApplicationPolicyReference, MaterializedPolicy, PolicySource } from "./schema.ts";
import { canonicalAgentPrompt, MAX_POLICY_BYTES, policySha256, readPolicySource } from "./sources.ts";
import { policyUnavailable } from "./errors.ts";

export type PolicyHost = { agentPolicies: AgentPolicies };

/** Resolve before journaling create intent or touching a provider. No registry/config mutation. */
export function resolveApplicationPolicy(host: PolicyHost, runtime: string,
  reference: ApplicationPolicyReference): MaterializedPolicy {
  const ref = ApplicationPolicyReferenceSchema.safeParse(reference);
  if (!ref.success) policyUnavailable("unknown", "invalid-reference");
  const parsed = AgentPoliciesSchema.safeParse(host.agentPolicies);
  if (!parsed.success) policyUnavailable(ref.data.id, "invalid-host-definition");
  const definition = parsed.data[ref.data.id];
  if (definition === undefined) policyUnavailable(ref.data.id, "unknown-policy");
  if (definition.runtime !== runtime) policyUnavailable(ref.data.id, "runtime-mismatch");
  if (definition.revision !== ref.data.revision) policyUnavailable(ref.data.id, "revision-mismatch");
  const seen = new Set<string>();
  let totalBytes = 0;
  const load = (source: PolicySource) => {
    if (seen.has(source.id)) policyUnavailable(ref.data.id, "duplicate-source-id");
    seen.add(source.id);
    const body = readPolicySource(ref.data.id, definition.trustedRoots, source);
    totalBytes += Buffer.byteLength(body);
    if (totalBytes > MAX_POLICY_BYTES) policyUnavailable(ref.data.id, "composition-size-limit");
    return { ...source, body };
  };
  const digest = policySha256(stableJson({ id: ref.data.id, ...definition }));
  if (definition.runtime === "codex") {
    const instructionSources = definition.instructionSources.map(load);
    const skills = definition.skills.map((skill) => ({ ...load(skill), name: skill.name }));
    if (new Set(skills.map((skill) => skill.name)).size !== skills.length)
      policyUnavailable(ref.data.id, "duplicate-skill-name");
    const metadata = ApplicationPolicyMetadataSchema.parse({ ...ref.data, runtime, digest,
      sources: [...instructionSources.map((source) => ({ id: source.id, digest: source.sha256, kind: "instructions" })),
        ...skills.map((skill) => ({ id: skill.id, digest: skill.sha256, kind: "skill" }))],
      capabilities: [...(instructionSources.length ? ["developer-instructions"] : []),
        ...(skills.length ? ["native-skills"] : [])],
    });
    return MaterializedPolicySchema.parse({ runtime, metadata, instructionSources, skills });
  }
  const source = load(definition.agent.source);
  const prompt = canonicalAgentPrompt(ref.data.id, source.body);
  if (prompt === "") policyUnavailable(ref.data.id, "empty-agent-prompt");
  const metadata = ApplicationPolicyMetadataSchema.parse({ ...ref.data, runtime, digest,
    sources: [{ id: source.id, digest: source.sha256, kind: "agent" }],
    capabilities: ["native-agent", ...(definition.denyTools.length ? ["tool-denials"] : [])],
  });
  return MaterializedPolicySchema.parse({ runtime, metadata,
    agent: { name: definition.agent.name, source, prompt }, denyTools: [...new Set(definition.denyTools)].sort() });
}

/** Re-run at every start/resume and turn admission. Accepted digests never follow edited sources. */
export function verifyApplicationPolicy(host: PolicyHost, runtime: string,
  accepted: ApplicationPolicyMetadata): MaterializedPolicy {
  const parsed = ApplicationPolicyMetadataSchema.safeParse(accepted);
  if (!parsed.success) policyUnavailable("unknown", "invalid-accepted-policy");
  const resolved = resolveApplicationPolicy(host, runtime, { id: parsed.data.id, revision: parsed.data.revision });
  if (stableJson(resolved.metadata) !== stableJson(parsed.data))
    policyUnavailable(parsed.data.id, "accepted-policy-changed");
  return resolved;
}

/** Project only safe metadata. `applied` is emitted by the adapter after native acknowledgement. */
export function applicationPolicyEvidence(policy: MaterializedPolicy,
  state: ApplicationPolicyEvidence["state"]): ApplicationPolicyEvidence {
  return ApplicationPolicyEvidenceSchema.parse({ policy: policy.metadata, state });
}

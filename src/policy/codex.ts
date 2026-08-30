import { z } from 'zod';
import { policyUnavailable } from './errors.ts';
import type { MaterializedPolicy } from './schema.ts';

const SkillInputSchema = z
  .object({ type: z.literal('skill'), name: z.string(), path: z.string() })
  .strict();
export type PolicySkillInput = z.infer<typeof SkillInputSchema>;
const InventorySchema = z.object({
  data: z
    .array(
      z.object({
        cwd: z.string().max(4096),
        errors: z.array(z.unknown()).max(1024),
        skills: z
          .array(
            z.object({
              name: z.string().max(128),
              path: z.string().max(4096),
              enabled: z.boolean(),
            }),
          )
          .max(4096),
      }),
    )
    .max(128),
});

/** Private thread/start + thread/resume parameter. Never add this materialization to process argv. */
export function composePolicyDeveloperInstructions(
  policy: MaterializedPolicy,
  supervisorInstructions: string,
): string {
  if (policy.runtime !== 'codex') policyUnavailable(policy.metadata.id, 'codex-policy-required');
  return [supervisorInstructions, ...policy.instructionSources.map((source) => source.body)]
    .filter((text) => text.length > 0)
    .join('\n\n');
}

/** Select native skill items, not copied skill bodies in a user text message. Call skills/list with
 * forceReload immediately before admission; discovery alone is not evidence of body application. */
export function policySkillInputs(
  policy: MaterializedPolicy,
  workspace: string,
  nativeInventory: unknown,
): PolicySkillInput[] {
  if (policy.runtime !== 'codex') policyUnavailable(policy.metadata.id, 'codex-policy-required');
  if (policy.skills.length === 0) return [];
  const parsed = InventorySchema.safeParse(nativeInventory);
  if (!parsed.success) policyUnavailable(policy.metadata.id, 'native-skill-inventory-unavailable');
  const entries = parsed.data.data.filter((entry) => entry.cwd === workspace);
  if (entries.length !== 1 || entries.some((entry) => entry.errors.length > 0))
    policyUnavailable(policy.metadata.id, 'native-skill-discovery-failed');
  const available = entries.flatMap((entry) => entry.skills);
  return policy.skills.map((skill) => {
    const candidates = available.filter((item) => item.name === skill.name);
    if (
      candidates.length !== 1 ||
      candidates.some((item) => item.path !== skill.path || !item.enabled)
    )
      policyUnavailable(policy.metadata.id, 'native-skill-selection-unavailable');
    return SkillInputSchema.parse({ type: 'skill', name: skill.name, path: skill.path });
  });
}

/** Native user-message acknowledgement of exact skill selections, not a discovery-only claim. */
export function nativePolicySkillsAcknowledged(
  policy: MaterializedPolicy,
  threadId: string,
  params: unknown,
): boolean {
  if (policy.runtime !== 'codex' || policy.skills.length === 0) return false;
  const parsed = z
    .object({
      threadId: z.string(),
      item: z.object({
        type: z.literal('userMessage'),
        content: z.array(z.unknown()).max(128),
      }),
    })
    .safeParse(params);
  if (!parsed.success || parsed.data.threadId !== threadId) return false;
  const selected = parsed.data.item.content.flatMap((item) => {
    const skill = SkillInputSchema.safeParse(item);
    return skill.success ? [skill.data] : [];
  });
  return policy.skills.every((skill) =>
    selected.some((item) => item.name === skill.name && item.path === skill.path),
  );
}

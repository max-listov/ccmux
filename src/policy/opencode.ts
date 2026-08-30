import { z } from 'zod';
import { policyUnavailable } from './errors.ts';
import type { MaterializedPolicy } from './schema.ts';

const NativeRuleSchema = z.object({
  permission: z.string().max(256),
  pattern: z.string().max(4096),
  action: z.enum(['allow', 'ask', 'deny']),
});
const NativeAgentsSchema = z
  .array(
    z.object({
      name: z.string().max(128),
      mode: z.enum(['primary', 'subagent', 'all']),
      hidden: z.boolean().nullish(),
      prompt: z
        .string()
        .max(256 * 1024)
        .optional(),
      permission: z.array(NativeRuleSchema).max(4096),
    }),
  )
  .max(1024);

function permissionMatches(pattern: string, tool: string): boolean {
  let position = 0;
  let cursor = 0;
  let star = -1;
  let restart = 0;
  while (cursor < tool.length) {
    if (pattern[position] === '?' || pattern[position] === tool[cursor]) {
      position++;
      cursor++;
    } else if (pattern[position] === '*') {
      star = position++;
      restart = cursor;
    } else if (star >= 0) {
      position = star + 1;
      cursor = ++restart;
    } else return false;
  }
  while (pattern[position] === '*') position++;
  return position === pattern.length;
}

/** The existing canonical native agent is selected, never rewritten. A declared denial needs an
 * effective all-resource deny with no later allow/ask exception; no policy emits permission grants. */
export function selectOpenCodePolicyAgent(
  policy: MaterializedPolicy,
  nativeAgents: unknown,
): string {
  if (policy.runtime !== 'opencode')
    policyUnavailable(policy.metadata.id, 'opencode-policy-required');
  const parsed = NativeAgentsSchema.safeParse(nativeAgents);
  if (!parsed.success) policyUnavailable(policy.metadata.id, 'native-agent-inventory-unavailable');
  const agents = parsed.data.filter((agent) => agent.name === policy.agent.name);
  const agent = agents[0];
  if (
    agents.length !== 1 ||
    agent === undefined ||
    agent.hidden === true ||
    agent.mode === 'subagent'
  )
    policyUnavailable(policy.metadata.id, 'native-agent-selection-unavailable');
  if (agent.prompt?.replace(/\r\n/g, '\n').trim() !== policy.agent.prompt)
    policyUnavailable(policy.metadata.id, 'native-agent-source-mismatch');
  for (const tool of policy.denyTools) {
    const relevant = agent.permission.filter((rule) => permissionMatches(rule.permission, tool));
    const index = relevant.findLastIndex((rule) => rule.pattern === '*' && rule.action === 'deny');
    if (index < 0 || relevant.slice(index + 1).some((rule) => rule.action !== 'deny'))
      policyUnavailable(policy.metadata.id, 'native-tool-denial-not-enforced');
  }
  return agent.name;
}

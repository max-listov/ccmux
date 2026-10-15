import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { Session } from '../types.ts';
import { delegationRefused, verifyDelegatedSession } from './resolve.ts';

/** Tools without write, shell, network or delegation effects; no inherited MCP or plugin tools. */
export const DELEGATED_CLAUDE_TOOLS = ['Read', 'Glob', 'Grep'];
export function delegatedClaudeOptions(session: Session): Partial<Options> {
  if (session.delegation === undefined) return {};
  verifyDelegatedSession(session);
  if (session.delegation.policy.access !== 'read-only')
    delegationRefused('Claude delegation requires read-only access');
  const guard: HookCallback = async (input) => {
    const allowed =
      input.hook_event_name === 'PreToolUse' && DELEGATED_CLAUDE_TOOLS.includes(input.tool_name);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: allowed ? 'allow' : 'deny',
        permissionDecisionReason: 'Immutable delegated read-only tool policy',
      },
    };
  };
  return {
    tools: [...DELEGATED_CLAUDE_TOOLS],
    allowedTools: [...DELEGATED_CLAUDE_TOOLS],
    settingSources: [],
    mcpServers: {},
    plugins: [],
    agents: {},
    extraArgs: { 'strict-mcp-config': null },
    hooks: { PreToolUse: [{ hooks: [guard] }] },
  };
}

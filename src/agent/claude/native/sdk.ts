import type {
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { MachineConfig, Session } from '../../../types.ts';
import { declaresDialogs, SUPPORTED_DIALOG_KINDS } from './permission.ts';
import { resolveAgentSdk } from './resolve.ts';

/** The part of the agent SDK this runtime calls. */
export interface AgentSdk {
  query: (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
  forkSession?: (
    id: string,
    options?: { upToMessageId?: string },
  ) => Promise<{ sessionId: string }>;
}

/**
 * Load the SDK the host configured. A runtime path from host configuration — which is also why no
 * bundler can see it and no host that leaves the mode off ever loads it.
 */
export async function loadAgentSdk(m: MachineConfig): Promise<AgentSdk> {
  const resolved = resolveAgentSdk(m);
  if ('unavailable' in resolved) throw new Error(resolved.detail);
  return (await import(resolved.path)) as AgentSdk;
}

/** The options one conversation runs under. */
export function sdkOptions(input: {
  m: MachineConfig;
  session: Session;
  env: Record<string, string | undefined>;
  /** Whether the conversation already exists, so it is resumed rather than created. */
  started: boolean;
  canUseTool: (toolName: string, input: unknown) => Promise<PermissionResult>;
}): Options {
  const { m, session } = input;
  const managedId = session.nativeSession?.id ?? '';
  return {
    pathToClaudeCodeExecutable: m.claudeBin,
    cwd: session.dir,
    env: input.env,
    // Without these two the runtime is a bare agent loop wearing Claude's model, not Claude Code:
    // no product system prompt, no CLAUDE.md, none of the operator's settings.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    includePartialMessages: true,
    // Only when the session asked for it: without this the runtime keeps no copies, and a rewind
    // has nothing to restore from — which is the honest state for a session nobody opted in.
    ...(session.fileCheckpoints === true ? { enableFileCheckpointing: true } : {}),
    permissionMode: 'default',
    // A chosen model is a turn option, not a different kind of session: the runtime family stays
    // `claude` and only the model within it changes.
    ...(session.modelSelection === undefined ? {} : { model: session.modelSelection.model }),
    canUseTool: input.canUseTool,
    ...(declaresDialogs() ? { supportedDialogKinds: [...SUPPORTED_DIALOG_KINDS] } : {}),
    // The id is pinned rather than discovered, so the managed identity and the runtime's own are
    // the same value. `sessionId` names a NEW conversation and cannot combine with `resume`.
    ...(input.started ? { resume: managedId } : { sessionId: managedId }),
  } as unknown as Options;
}

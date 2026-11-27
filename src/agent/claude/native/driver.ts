import { dirname, resolve } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { type ExecutorProfileConfig, sanitizeProfileEnv } from 'stitchkit/agent-executor';
import type {
  ClaudeRuntimeEvent,
  ClaudeSdkDriverConfig,
  ClaudeSdkForkSession,
  ClaudeSdkPermissionRequestMeta,
  ClaudeSdkQueryExitContext,
  ClaudeSdkTurnUsage,
} from 'stitchkit/agent-executor/claude-sdk';
import { delegatedClaudeOptions } from '../../../delegation/claude.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { HOME } from '../../../util/env.ts';
import { claudeProfileId } from '../namedProfiles.ts';
import { claudeProfile } from '../profileRoot.ts';
import { declaresDialogs, SUPPORTED_DIALOG_KINDS } from './permission.ts';
import { resolveAgentSdk } from './resolve.ts';

/** The part of the agent SDK this runtime calls. */
export interface AgentSdk {
  query: (input: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
  forkSession?: ClaudeSdkForkSession;
}

/**
 * Load the SDK the host configured. A runtime path from host configuration — which is also why no
 * bundler can see it and no host that leaves the mode off ever loads it.
 */
export async function loadAgentSdk(m: MachineConfig): Promise<AgentSdk> {
  const resolved = resolveAgentSdk(m);
  if ('unavailable' in resolved) throw new Error(resolved.detail);
  const sdk = (await import(resolved.path)) as Partial<AgentSdk>;
  if (typeof sdk.query !== 'function')
    throw new Error('the agent SDK at this path exposes no query entry point');
  return sdk as AgentSdk;
}

/** Build the executor profile passed to `stitchkit/agent-executor/claude-sdk`. */
export function claudeExecutorProfile(
  m: Pick<MachineConfig, 'projectsDir'>,
  session: Pick<Session, 'dir' | 'envFile' | 'name' | 'profile'>,
  env: Readonly<Record<string, string | undefined>> = {},
): ExecutorProfileConfig {
  const profile = claudeProfile(session, m);
  const home = profile.configDir ?? dirname(profile.projectsDir);
  // A configured transcript root remains an explicit executor home. At the stock root,
  // setting CLAUDE_CONFIG_DIR would select a different Keychain login.
  const implicit =
    profile.configDir === null && resolve(home) === resolve(env.HOME ?? HOME, '.claude');
  return {
    engine: 'claude-sdk',
    profileId: session.profile ? claudeProfileId(session.profile) : session.name,
    home,
    ...(implicit ? { claudeConfigDir: 'default' } : {}),
    env: sanitizeProfileEnv(env),
  };
}

/** Build the `stitchkit/agent-executor/claude-sdk` driver configuration for one managed session. */
export function claudeSdkDriverConfig(input: {
  m: MachineConfig;
  session: Session;
  sdk: AgentSdk;
  onProviderPid?: (pid: number) => void;
  stderr?: (chunk: string) => void;
  onQueryExit?: (error: unknown, context: ClaudeSdkQueryExitContext) => void;
  onPermissionRequest?: (meta: ClaudeSdkPermissionRequestMeta) => void;
  onTurnUsage?: (usage: ClaudeSdkTurnUsage) => void;
  onEvent?: (event: ClaudeRuntimeEvent) => void;
  resolveFile?: (reference: string) => Promise<Uint8Array>;
}): ClaudeSdkDriverConfig {
  const { m, session, sdk } = input;
  const delegated = delegatedClaudeOptions(session);
  return {
    query: sdk.query,
    sdkVersion: session.nativeSession?.version ?? 'unknown',
    ...(sdk.forkSession === undefined ? {} : { forkSession: sdk.forkSession }),
    ...(m.claudeBin === undefined ? {} : { pathToClaudeCodeExecutable: m.claudeBin }),
    // Without these two the runtime is a bare agent loop wearing Claude's model, not Claude Code:
    // no product system prompt, no CLAUDE.md, none of the operator's settings.
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    // Only when the session asked for it: without this the runtime keeps no copies, and a rewind
    // has nothing to restore from — which is the honest state for a session nobody opted in.
    ...(session.fileCheckpoints === true ? { enableFileCheckpointing: true } : {}),
    permissionMode: 'default',
    ...(session.modelSelection === undefined ? {} : { model: session.modelSelection.model }),
    ...(delegated.tools === undefined ? {} : { tools: delegated.tools }),
    ...(delegated.allowedTools === undefined ? {} : { allowedTools: delegated.allowedTools }),
    ...(delegated.settingSources === undefined ? {} : { settingSources: delegated.settingSources }),
    ...(delegated.mcpServers === undefined ? {} : { mcpServers: delegated.mcpServers }),
    ...(delegated.plugins === undefined ? {} : { plugins: delegated.plugins }),
    ...(delegated.agents === undefined ? {} : { agents: delegated.agents }),
    ...(delegated.extraArgs === undefined ? {} : { extraArgs: delegated.extraArgs }),
    ...(delegated.hooks === undefined ? {} : { hooks: delegated.hooks }),
    ...(session.delegation === undefined
      ? {}
      : { verifyDelegation: { requireHooksApplied: true, requireNoMcpServers: true } }),
    ...(declaresDialogs() ? { supportedDialogKinds: [...SUPPORTED_DIALOG_KINDS] } : {}),
    ...(input.onProviderPid === undefined ? {} : { onProviderPid: input.onProviderPid }),
    ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
    ...(input.onQueryExit === undefined ? {} : { onQueryExit: input.onQueryExit }),
    ...(input.onPermissionRequest === undefined
      ? {}
      : { onPermissionRequest: input.onPermissionRequest }),
    ...(input.onTurnUsage === undefined ? {} : { onTurnUsage: input.onTurnUsage }),
    ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
    ...(input.resolveFile === undefined ? {} : { resolveFile: input.resolveFile }),
  };
}

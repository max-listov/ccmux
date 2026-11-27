import type { ClaudeSdkSession } from 'stitchkit/agent-executor/claude-sdk';
import {
  planLimitsReadFailed,
  projectExecutorPlanLimits,
  unpublishedPlanLimits,
} from '../../../runtime/planLimits.ts';
import { seedNativeSelection } from '../../../runtime/selection.ts';
import type { MachineConfig, Session } from '../../../types.ts';
import { accountIsEmpty, nativeAccount } from './account.ts';
import { claudeModels, writeClaudeCatalog } from './catalog.ts';
import { claudeCommands, writeClaudeCommands } from './commands.ts';
import { nativeContextUsage } from './context.ts';
import { nativeMcpServers } from './mcp.ts';
import type { NativeProjection } from './projection.ts';

/**
 * What a session can be asked ABOUT itself via `ClaudeSdkSession`: its models, commands, account,
 * MCP servers, context window, and subscription plan limits.
 */
export interface Discovery {
  m: MachineConfig;
  session: Session;
  sdkSession: ClaudeSdkSession | null;
  projection: NativeProjection;
  report: (error: unknown) => Promise<void>;
}

export async function loadCatalog(d: Discovery): Promise<void> {
  try {
    const supported = await d.sdkSession?.supportedModels();
    if (!supported) {
      if (d.session.initialization === 'no-inference')
        throw new Error('No-inference admission requires the runtime model catalog');
      return;
    }
    const chosen = d.session.modelSelection?.model ?? null;
    const models = claudeModels(supported, chosen);
    if (d.session.initialization === 'no-inference' && !models.some((model) => model.id === chosen))
      throw new Error('No-inference admission could not verify the explicit model');
    await writeClaudeCatalog(d.m, d.session, models);
    const current = models.find((model) => model.isDefault) ?? models[0];
    if (current)
      d.projection.selection = {
        model: { provider: 'claude', model: current.id },
        options: { runtime: 'claude', model: { provider: 'claude', model: current.id } },
        source: d.session.modelSelection === undefined ? 'settings' : 'admission',
        turnId: null,
      };
    const requested = d.session.modelSelection;
    if (requested !== undefined && models.some((model) => model.id === requested.model))
      await seedNativeSelection(d.m, d.session, {
        runtime: 'claude',
        model: { provider: 'claude', model: requested.model },
      });
  } catch (error) {
    if (d.session.initialization === 'no-inference') throw error;
    await d.report(error);
  }
}

export async function loadCommands(d: Discovery): Promise<void> {
  try {
    const supported = await d.sdkSession?.supportedCommands();
    if (!supported) return;
    await writeClaudeCommands(d.m, d.session, claudeCommands(supported));
  } catch (error) {
    await d.report(error);
  }
}

export async function loadAccount(d: Discovery): Promise<void> {
  try {
    const reported = await d.sdkSession?.accountInfo();
    if (!reported) return;
    const account = nativeAccount(reported);
    if (!accountIsEmpty(account)) d.projection.account = account;
  } catch (error) {
    await d.report(error);
  }
}

export async function refreshMcpServers(d: Discovery): Promise<void> {
  try {
    const reported = await d.sdkSession?.mcpServerStatus();
    if (!reported) return;
    d.projection.mcpServers = nativeMcpServers(reported);
  } catch (error) {
    await d.report(error);
  }
}

export async function refreshContextUsage(d: Discovery): Promise<void> {
  try {
    const reported = await d.sdkSession?.getContextUsage();
    if (!reported) return;
    d.projection.contextUsage = nativeContextUsage(reported, Date.now());
  } catch (error) {
    await d.report(error);
  }
}

export async function refreshPlanLimits(d: Discovery): Promise<void> {
  const sdkSession = d.sdkSession;
  if (sdkSession === null) {
    d.projection.planLimits ??= unpublishedPlanLimits(Date.now());
    return;
  }
  try {
    const read = await sdkSession.readUsage();
    if (!read.supported) {
      d.projection.planLimits ??= unpublishedPlanLimits(Date.now());
      return;
    }
    d.projection.planLimits = projectExecutorPlanLimits(read.planLimits);
  } catch (error) {
    d.projection.planLimits = planLimitsReadFailed(
      d.projection.planLimits,
      Date.now(),
      String(error),
    );
    await d.report(error);
  }
}

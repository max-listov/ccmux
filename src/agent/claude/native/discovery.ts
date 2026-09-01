import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { MachineConfig, Session } from '../../../types.ts';
import { accountIsEmpty, nativeAccount, type ReportedAccount } from './account.ts';
import { claudeModels, type SupportedModel, writeClaudeCatalog } from './catalog.ts';
import { claudeCommands, type SupportedCommand, writeClaudeCommands } from './commands.ts';
import { nativeContextUsage, type ReportedContextUsage } from './context.ts';
import { nativeMcpServers, type ReportedMcpServer } from './mcp.ts';
import type { NativeProjection } from './projection.ts';

/**
 * What a session can be asked ABOUT itself: its models, its commands, its account, its MCP servers,
 * its context window.
 *
 * All five ask the runtime once and leave the answer where a reader without a connection can find
 * it, and all five treat a runtime that cannot answer as enrichment missing rather than as a
 * session failing. They live beside the owner rather than inside it because none of them advances
 * the conversation — they only describe it.
 */
export interface Discovery {
  m: MachineConfig;
  session: Session;
  query: Query | null;
  projection: NativeProjection;
  report: (error: unknown) => Promise<void>;
}

/**
 * Ask the runtime what it can run, once, and leave the answer where a catalog read can find it.
 *
 * Only this process holds a connection, and the read runs elsewhere — so a list nobody published
 * would have to be invented by the reader, which is exactly the kind of plausible answer this
 * project refuses to give. A runtime that cannot answer leaves no file, and the read says
 * unavailable rather than guessing.
 */
export async function loadCatalog(d: Discovery): Promise<void> {
  try {
    const supported = (await d.query?.supportedModels?.()) as SupportedModel[] | undefined;
    if (!supported) return;
    const chosen = d.session.modelSelection?.model ?? null;
    const models = claudeModels(supported, chosen);
    await writeClaudeCatalog(d.m, d.session, models);
    const current = models.find((model) => model.isDefault) ?? models[0];
    if (current)
      d.projection.selection = {
        model: { provider: 'claude', model: current.id },
        options: { runtime: 'claude', model: { provider: 'claude', model: current.id } },
        source: d.session.modelSelection === undefined ? 'settings' : 'admission',
        turnId: null,
      };
  } catch (error) {
    // A catalog is enrichment, not a precondition: a session that cannot list models still runs.
    await d.report(error);
  }
}

/**
 * Ask the runtime which slash commands it offers, and leave the answer where a read can find it.
 *
 * Same reason as the model catalog: the reader runs elsewhere. A session that cannot answer leaves
 * no file, and the read says unavailable rather than offering a vocabulary nobody verified.
 */
export async function loadCommands(d: Discovery): Promise<void> {
  try {
    const supported = (await d.query?.supportedCommands?.()) as SupportedCommand[] | undefined;
    if (!supported) return;
    await writeClaudeCommands(d.m, d.session, claudeCommands(supported));
  } catch (error) {
    // A vocabulary is enrichment, not a precondition: a session that cannot list commands still runs.
    await d.report(error);
  }
}

/**
 * Ask which account this session runs on.
 *
 * Once, at start: the answer does not change while a session lives, and asking per turn would be
 * a round trip for a constant. A runtime that says nothing publishes nothing — an account nobody
 * named is not an account of unknown name.
 */
export async function loadAccount(d: Discovery): Promise<void> {
  try {
    const reported = (await d.query?.accountInfo?.()) as ReportedAccount | undefined;
    if (!reported) return;
    const account = nativeAccount(reported);
    if (!accountIsEmpty(account)) d.projection.account = account;
  } catch (error) {
    await d.report(error);
  }
}

/**
 * Read the session's MCP servers and their connection status.
 *
 * A failed server is otherwise invisible: the only sign is a tool that quietly is not there, and
 * a supervisor that cannot say which server failed cannot help.
 */
export async function refreshMcpServers(d: Discovery): Promise<void> {
  try {
    const reported = (await d.query?.mcpServerStatus?.()) as ReportedMcpServer[] | undefined;
    if (!reported) return;
    d.projection.mcpServers = nativeMcpServers(reported);
  } catch (error) {
    await d.report(error);
  }
}

/**
 * Ask the runtime how full its context window is.
 *
 * Failure is silence, not a fault: a measurement that cannot be taken leaves the previous one
 * standing, and a session that cannot answer still runs. Publishing a zero would be worse than
 * publishing nothing, because a zero reads as an empty window.
 */
export async function refreshContextUsage(d: Discovery): Promise<void> {
  try {
    const reported = (await d.query?.getContextUsage?.()) as ReportedContextUsage | undefined;
    if (!reported) return;
    d.projection.contextUsage = nativeContextUsage(reported, Date.now());
  } catch (error) {
    await d.report(error);
  }
}

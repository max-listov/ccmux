import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { AgentLanguageModelProvider, AgentUsage } from 'stitchkit/agent-runtime';
import { openRouterProvider } from 'stitchkit/agent-runtime/openrouter';
import type { PreparedCustomHost } from './host.ts';

/**
 * Which adapter serves this host's models — composition, not a second inference path.
 *
 * Both kinds produce the same two-method provider the model registry already consumes, so the
 * harness, the store, the tool loop and the approval flow are untouched by the choice. What differs
 * is only who answers and under whose identity, which is exactly the distinction the registry is
 * asked to preserve.
 *
 * The local adapter is the published OpenAI-compatible provider rather than a request path written
 * here: a local model server speaks that protocol, and writing our own client for it would add a
 * transport to maintain and a second place for streaming and tool-call decoding to disagree.
 */

/** A count the provider actually gave, kept apart from one it never mentioned. */
function reported(value: number | undefined): AgentUsage['inputTokens'] {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? { provenance: 'unavailable' }
    : { value, provenance: 'provider-reported' };
}

/**
 * Local usage, with silence preserved as silence.
 *
 * Local servers differ in what they report: some send complete token counts, some omit them on a
 * streamed response, some send zeros. Mapping an absent count to `0` would turn "this server did
 * not say" into "this server said none", and a context-budget decision taken on that number would
 * be taken on a fabricated fact. Cost is always unavailable rather than zero for the same reason —
 * no price was reported, which is not the same claim as a price of nothing.
 */
function normalizeLocalUsage({
  usage,
}: {
  usage: Parameters<NonNullable<AgentLanguageModelProvider['normalizeUsage']>>[0]['usage'];
}): AgentUsage {
  return {
    inputTokens: reported(usage.inputTokens),
    outputTokens: reported(usage.outputTokens),
    reasoningTokens: reported(usage.outputTokenDetails.reasoningTokens),
    cacheReadTokens: reported(usage.inputTokenDetails.cacheReadTokens),
    cacheWriteTokens: reported(usage.inputTokenDetails.cacheWriteTokens),
    cost: { provenance: 'unavailable' },
  };
}

/** Compose the adapter this host's provider configuration names. */
export function customLanguageModelProvider(host: PreparedCustomHost): AgentLanguageModelProvider {
  const { provider } = host.config;
  if (provider.kind === 'openrouter') {
    if (host.credential === undefined)
      throw new Error('Custom execution credentials are unavailable or invalid');
    return openRouterProvider({ apiKey: host.credential });
  }
  const compatible = createOpenAICompatible({
    name: provider.kind,
    baseURL: provider.endpoint,
    ...(host.credential === undefined ? {} : { apiKey: host.credential }),
  });
  return {
    create: (modelId) => compatible.chatModel(modelId),
    normalizeUsage: normalizeLocalUsage,
  };
}

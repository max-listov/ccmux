import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { MachineConfig } from '../types.ts';
import { recordUsageBatch } from './live.ts';
import { token } from './normalize.ts';
import { emptyUsage, type UsageFact } from './schema.ts';

/** Query-pipeline totals include subagents. They never add to transcript self usage. */
export function recordClaudeSdkUsage(
  m: Pick<MachineConfig, 'stateDir'>,
  uuid: string,
  epoch: string,
  message: SDKMessage,
) {
  if (message.type !== 'result') return;
  const at = new Date().toISOString();
  const facts: UsageFact[] = [];
  for (const [model, usage] of Object.entries(message.modelUsage)) {
    facts.push({
      id: `${message.uuid}:${model}`,
      runtime: 'claude',
      model,
      provider: usage.provider ?? null,
      at: null,
      observedAt: at,
      scope: 'session',
      mode: 'cumulative',
      epoch,
      identity: 'native',
      inputIncludesCache: false,
      outputIncludesReasoning: true,
      metrics: {
        ...emptyUsage(),
        inputTokens: token(usage.inputTokens),
        outputTokens: token(usage.outputTokens),
        cacheReadTokens: token(usage.cacheReadInputTokens),
        cacheCreationTokens: token(usage.cacheCreationInputTokens),
        reasoningTokens: token(usage.thinkingTokens),
      },
      cost:
        Number.isFinite(usage.costUSD) && usage.costUSD >= 0
          ? { value: usage.costUSD, currency: 'USD', provenance: 'estimated' }
          : null,
      details: {
        canonicalModel: usage.canonicalModel ?? null,
        costBasis: usage.costBasis ?? null,
        webSearchRequests: token(usage.webSearchRequests),
        contextWindow: token(usage.contextWindow),
        maxOutputTokens: token(usage.maxOutputTokens),
      },
    });
  }
  recordUsageBatch(m, uuid, facts);
}

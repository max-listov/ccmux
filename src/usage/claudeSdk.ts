import type { ClaudeSdkTurnUsage } from 'stitchkit/agent-executor/claude-sdk';
import type { MachineConfig } from '../types.ts';
import { recordUsageBatch } from './live.ts';
import { token } from './normalize.ts';
import { emptyUsage, type UsageFact } from './schema.ts';

/** Query-pipeline totals include subagents. They never add to transcript self usage. */
export function recordClaudeSdkUsage(
  m: Pick<MachineConfig, 'stateDir'>,
  uuid: string,
  epoch: string,
  turnUsage: ClaudeSdkTurnUsage,
) {
  const cumulative = turnUsage.cumulativeModelUsage;
  if (cumulative === undefined) return;
  const at = new Date().toISOString();
  const facts: UsageFact[] = [];
  for (const [model, usage] of Object.entries(cumulative)) {
    facts.push({
      id: `${turnUsage.turnId}:${model}`,
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
        usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
          ? { value: usage.costUsd, currency: 'USD', provenance: 'estimated' }
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

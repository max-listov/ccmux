import type { AgentRunMetrics } from 'stitchkit/agent-runtime';
import type { OpenCodeMessage } from '../agent/opencode/protocol.ts';
import type { MachineConfig } from '../types.ts';
import { eventTime, token } from './normalize.ts';
import { liveUsagePath } from './paths.ts';
import { emptyUsage, type UsageFact } from './schema.ts';
import { UsageStore } from './store.ts';

export function recordUsage(m: Pick<MachineConfig, 'stateDir'>, uuid: string, fact: UsageFact) {
  recordUsageBatch(m, uuid, [fact]);
}

export function recordUsageBatch(
  m: Pick<MachineConfig, 'stateDir'>,
  uuid: string,
  facts: UsageFact[],
) {
  const store = new UsageStore(liveUsagePath(m, uuid));
  try {
    store.transaction(() => {
      for (const fact of facts) store.put(fact);
    });
  } finally {
    store.close();
  }
}

export function openCodeUsage(message: OpenCodeMessage, observedAt: string): UsageFact | null {
  if (message.role !== 'assistant' || !message.tokens) return null;
  const t = message.tokens;
  return {
    id: message.id,
    runtime: 'opencode',
    model: message.modelID ?? null,
    provider: message.providerID ?? null,
    at: new Date(message.time.created).toISOString(),
    observedAt,
    scope: 'message',
    mode: 'replacement',
    epoch: message.sessionID,
    identity: 'native',
    inputIncludesCache: null,
    outputIncludesReasoning: null,
    metrics: {
      inputTokens: token(t.input),
      outputTokens: token(t.output),
      cacheReadTokens: token(t.cache.read),
      cacheCreationTokens: token(t.cache.write),
      reasoningTokens: token(t.reasoning),
      totalTokens: token(t.total),
    },
    cost: null,
  };
}

export function customUsage(
  usage: AgentRunMetrics['usage'],
  run: string,
  epoch: string,
  at: string,
  model: string | null,
  provider: string | null,
): UsageFact {
  const cost = usage.cost;
  return {
    id: run,
    runtime: 'custom',
    model,
    provider,
    at: eventTime(at),
    observedAt: new Date().toISOString(),
    scope: 'run',
    mode: 'replacement',
    epoch,
    identity: 'native',
    inputIncludesCache: null,
    outputIncludesReasoning: null,
    metrics: {
      ...emptyUsage(),
      inputTokens: token(usage.inputTokens.value),
      outputTokens: token(usage.outputTokens.value),
      cacheReadTokens: token(usage.cacheReadTokens?.value),
      cacheCreationTokens: token(usage.cacheWriteTokens?.value),
      reasoningTokens: token(usage.reasoningTokens?.value),
    },
    provenance: {
      inputTokens: usage.inputTokens.provenance,
      outputTokens: usage.outputTokens.provenance,
      cacheReadTokens: usage.cacheReadTokens?.provenance ?? 'unavailable',
      cacheCreationTokens: usage.cacheWriteTokens?.provenance ?? 'unavailable',
      reasoningTokens: usage.reasoningTokens?.provenance ?? 'unavailable',
      totalTokens: 'unavailable',
    },
    cost:
      typeof cost?.value === 'number' && cost.currency
        ? { value: cost.value, currency: cost.currency, provenance: cost.provenance }
        : null,
  };
}

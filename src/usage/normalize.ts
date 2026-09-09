import { createHash } from 'node:crypto';
import { rec, str } from '../agent/normalize.ts';
import { emptyUsage, type UsageFact, UsageFactSchema, type UsageMetrics } from './schema.ts';

export function token(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid provider usage count');
  return value;
}
export function eventTime(value: unknown): string | null {
  const text = str(value);
  if (!text || !Number.isFinite(Date.parse(text))) return null;
  return new Date(text).toISOString();
}
export function claudeMetrics(value: unknown): UsageMetrics {
  const u = rec(value);
  return {
    ...emptyUsage(),
    inputTokens: token(u?.input_tokens),
    outputTokens: token(u?.output_tokens),
    reasoningTokens: token(rec(u?.output_tokens_details)?.thinking_tokens),
    cacheReadTokens: token(u?.cache_read_input_tokens),
    cacheCreationTokens: token(u?.cache_creation_input_tokens),
  };
}
export function codexMetrics(value: unknown): UsageMetrics {
  const u = rec(value);
  return {
    inputTokens: token(u?.input_tokens),
    outputTokens: token(u?.output_tokens),
    cacheReadTokens: token(u?.cached_input_tokens),
    cacheCreationTokens: null,
    reasoningTokens: token(u?.reasoning_output_tokens),
    totalTokens: token(u?.total_tokens),
  };
}
export interface UsageParseContext {
  model: string | null;
  epoch: string;
}
export function parseUsageRecord(
  runtime: string,
  entry: Record<string, unknown>,
  context: UsageParseContext,
  observedAt: string,
): UsageFact | null {
  const payload = rec(entry.payload);
  if (runtime === 'codex' && entry.type === 'turn_context') context.model = str(payload?.model);
  if (runtime === 'codex' && entry.type === 'session_meta') {
    const id = str(payload?.id);
    if (id) context.epoch = id;
  }
  const at = eventTime(entry.timestamp);
  if (runtime === 'claude') {
    const message = rec(entry.message);
    if (entry.type !== 'assistant' || !message) return null;
    const native = str(message.id);
    const id = native ?? str(entry.uuid);
    if (!id) throw new Error('Usage-bearing message has no identity');
    return UsageFactSchema.parse({
      id,
      runtime,
      model: str(message.model),
      provider: null,
      at,
      observedAt,
      scope: 'message',
      mode: 'replacement',
      epoch: context.epoch,
      inputIncludesCache: false,
      outputIncludesReasoning: rec(rec(message.usage)?.output_tokens_details) ? true : null,
      metrics: claudeMetrics(message.usage),
      cost: null,
      identity: native ? 'native' : 'record',
    });
  }
  if (runtime === 'codex' && entry.type === 'event_msg' && payload?.type === 'token_count') {
    const info = rec(payload.info);
    if (!rec(info?.total_token_usage)) return null;
    // A replay of the same provider event is not another charge. No text enters the identity.
    const metrics = codexMetrics(info?.total_token_usage);
    const id = createHash('sha256')
      .update(JSON.stringify([context.epoch, at, metrics]))
      .digest('hex');
    return UsageFactSchema.parse({
      id,
      runtime,
      model: context.model,
      provider: null,
      at,
      observedAt,
      scope: 'session',
      mode: 'cumulative',
      epoch: context.epoch,
      inputIncludesCache: null,
      outputIncludesReasoning: null,
      metrics,
      cost: null,
      identity: 'record',
    });
  }
  return null;
}

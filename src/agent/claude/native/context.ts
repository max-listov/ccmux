import {
  type NativeContextUsage,
  NativeContextUsageSchema,
  type NativeSnapshot,
} from '../../../runtime/projectionSchema.ts';
import type { ContextInfo } from '../../../types.ts';

/**
 * The runtime's own measurement of its context window, reduced to what a reader needs.
 *
 * Read from the runtime rather than parsed out of a statusline, which is what the interactive mode
 * has to do. The scrape cannot distinguish a model's hard limit from a smaller compaction window —
 * it only ever sees one number — and that difference is the whole meaning of a percentage.
 */
export interface ReportedContextUsage {
  totalTokens: number;
  maxTokens: number;
  rawMaxTokens: number;
  percentage: number;
}

export function nativeContextUsage(
  reported: ReportedContextUsage,
  now: number,
): NativeContextUsage {
  const limit = Math.max(1, Math.round(reported.maxTokens));
  const raw = Math.max(1, Math.round(reported.rawMaxTokens));
  return NativeContextUsageSchema.parse({
    usedTokens: Math.max(0, Math.round(reported.totalTokens)),
    limitTokens: limit,
    rawLimitTokens: raw,
    // Clamped rather than trusted: a percentage past 100 is what a window being exceeded looks like,
    // and a reader rendering a bar would draw past its own edge.
    percent: Math.min(100, Math.max(0, Math.round(reported.percentage))),
    // A limit below the model's own is a policy window, and saying which one a number was measured
    // against is the difference between "nearly full" and "nearly at the compaction point".
    window: limit < raw ? 'compaction-window' : 'model-limit',
    observedAt: new Date(now).toISOString(),
  });
}

const fmt = (tokens: number): string =>
  tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1e3)}k`;

/**
 * The same shape every other session reports, so a consumer never branches on runtime to read
 * context fill. A session that has taken no turn reports nothing, which is not the same as zero.
 */
export function nativeContextInfo(snapshot: NativeSnapshot | null | undefined): ContextInfo {
  const usage = snapshot?.contextUsage;
  if (!usage) return { text: null, usedTokens: null, limitTokens: null, percent: null };
  return {
    text: `${fmt(usage.usedTokens)}/${fmt(usage.limitTokens)} ${usage.percent}%`,
    usedTokens: usage.usedTokens,
    limitTokens: usage.limitTokens,
    percent: usage.percent,
  };
}
